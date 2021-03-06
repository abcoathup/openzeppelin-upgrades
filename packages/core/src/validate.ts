import { isNodeType, findAll } from 'solidity-ast/utils';
import type { ContractDefinition } from 'solidity-ast';
import chalk from 'chalk';

import { SolcOutput, SolcBytecode } from './solc-api';
import { Version, getVersion } from './version';
import { extractStorageLayout, StorageLayout } from './storage';
import { extractLinkReferences, unlinkBytecode, LinkReference } from './link-refs';
import { UpgradesError, ErrorDescriptions } from './error';
import { SrcDecoder } from './src-decoder';
import { isNullish } from './utils/is-nullish';

export type ValidationLog = RunValidation[];
export type RunValidation = Record<string, ContractValidation>;

// upgrades-core@1.3.0 introduced ValidationLog but for compatibility with ^1.0.0
// the functions exported by this module also accept a single RunValidation
type Validations = ValidationLog | RunValidation;

// aliases for backwards compatibility with ^1.0.0
export type Validation = RunValidation;
export type ValidationResult = ContractValidation;

export interface ContractValidation {
  version?: Version;
  inherit: string[];
  libraries: string[];
  linkReferences: LinkReference[];
  errors: ValidationError[];
  layout: StorageLayout;
}

type ValidationError = ValidationErrorConstructor | ValidationErrorOpcode | ValidationErrorWithName;

interface ValidationErrorBase {
  src: string;
}

interface ValidationErrorWithName extends ValidationErrorBase {
  name: string;
  kind:
    | 'state-variable-assignment'
    | 'state-variable-immutable'
    | 'external-library-linking'
    | 'struct-definition'
    | 'enum-definition';
}

interface ValidationErrorConstructor extends ValidationErrorBase {
  kind: 'constructor';
  contract: string;
}

interface ValidationErrorOpcode extends ValidationErrorBase {
  kind: 'delegatecall' | 'selfdestruct';
}

export interface ValidationOptions {
  unsafeAllowCustomTypes?: boolean;
  unsafeAllowLinkedLibraries?: boolean;
}

export function withValidationDefaults(opts: ValidationOptions): Required<ValidationOptions> {
  return {
    unsafeAllowCustomTypes: opts.unsafeAllowCustomTypes ?? false,
    unsafeAllowLinkedLibraries: opts.unsafeAllowLinkedLibraries ?? false,
  };
}

export function validate(solcOutput: SolcOutput, decodeSrc: SrcDecoder): RunValidation {
  const validation: RunValidation = {};
  const fromId: Record<number, string> = {};
  const inheritIds: Record<string, number[]> = {};
  const libraryIds: Record<string, number[]> = {};

  for (const source in solcOutput.contracts) {
    for (const contractName in solcOutput.contracts[source]) {
      const bytecode = solcOutput.contracts[source][contractName].evm.bytecode;
      const version = bytecode.object === '' ? undefined : getVersion(bytecode.object);
      const linkReferences = extractLinkReferences(bytecode);

      validation[contractName] = {
        version,
        inherit: [],
        libraries: [],
        linkReferences,
        errors: [],
        layout: {
          storage: [],
          types: {},
        },
      };
    }

    for (const contractDef of findAll('ContractDefinition', solcOutput.sources[source].ast)) {
      fromId[contractDef.id] = contractDef.name;

      if (contractDef.name in validation) {
        const { bytecode } = solcOutput.contracts[source][contractDef.name].evm;
        inheritIds[contractDef.name] = contractDef.linearizedBaseContracts.slice(1);
        libraryIds[contractDef.name] = getReferencedLibraryIds(contractDef);

        validation[contractDef.name].errors = [
          ...getConstructorErrors(contractDef, decodeSrc),
          ...getDelegateCallErrors(contractDef, decodeSrc),
          ...getStateVariableErrors(contractDef, decodeSrc),
          // TODO: add support for structs and enums
          // https://github.com/OpenZeppelin/openzeppelin-upgrades/issues/3
          ...getStructErrors(contractDef, decodeSrc),
          ...getEnumErrors(contractDef, decodeSrc),
          // TODO: add linked libraries support
          // https://github.com/OpenZeppelin/openzeppelin-upgrades/issues/52
          ...getLinkingErrors(contractDef, bytecode),
        ];

        validation[contractDef.name].layout = extractStorageLayout(contractDef, decodeSrc);
      }
    }
  }

  for (const contractName in inheritIds) {
    validation[contractName].inherit = inheritIds[contractName].map(id => fromId[id]);
  }

  for (const contractName in libraryIds) {
    validation[contractName].libraries = libraryIds[contractName].map(id => fromId[id]);
  }

  return validation;
}

export function getContractVersion(validation: RunValidation, contractName: string): Version {
  const { version } = validation[contractName];
  if (version === undefined) {
    throw new Error(`Contract ${contractName} is abstract`);
  }
  return version;
}

export function getContractNameAndRunValidation(validations: Validations, version: Version): [string, RunValidation] {
  const validationLog = Array.isArray(validations) ? validations : [validations];

  let runValidation;
  let contractName;

  for (const validation of validationLog) {
    contractName = Object.keys(validation).find(
      name => validation[name].version?.withMetadata === version.withMetadata,
    );
    if (contractName !== undefined) {
      runValidation = validation;
      break;
    }
  }

  if (contractName === undefined || runValidation === undefined) {
    throw new Error('The requested contract was not found. Make sure the source code is available for compilation');
  }

  return [contractName, runValidation];
}

export function getStorageLayout(validations: Validations, version: Version): StorageLayout {
  const [contractName, runValidation] = getContractNameAndRunValidation(validations, version);
  const c = runValidation[contractName];
  const layout: StorageLayout = { storage: [], types: {} };
  for (const name of [contractName].concat(c.inherit)) {
    layout.storage.unshift(...runValidation[name].layout.storage);
    Object.assign(layout.types, runValidation[name].layout.types);
  }
  return layout;
}

export function getUnlinkedBytecode(validations: Validations, bytecode: string): string {
  const validationLog = Array.isArray(validations) ? validations : [validations];

  for (const validation of validationLog) {
    const linkableContracts = Object.keys(validation).filter(name => validation[name].linkReferences.length > 0);

    for (const name of linkableContracts) {
      const { linkReferences } = validation[name];
      const unlinkedBytecode = unlinkBytecode(bytecode, linkReferences);
      const version = getVersion(unlinkedBytecode);

      if (validation[name].version?.withMetadata === version.withMetadata) {
        return unlinkedBytecode;
      }
    }
  }

  return bytecode;
}

export function assertUpgradeSafe(validations: Validations, version: Version, opts: ValidationOptions): void {
  const [contractName] = getContractNameAndRunValidation(validations, version);

  let errors = getErrors(validations, version);
  errors = processExceptions(contractName, errors, opts);

  if (errors.length > 0) {
    throw new ValidationErrors(contractName, errors);
  }
}

function processExceptions(
  contractName: string,
  errorsToProcess: ValidationError[],
  opts: ValidationOptions,
): ValidationError[] {
  const { unsafeAllowCustomTypes, unsafeAllowLinkedLibraries } = withValidationDefaults(opts);
  let errors: ValidationError[] = errorsToProcess;

  // Process `unsafeAllowCustomTypes` flag
  if (unsafeAllowCustomTypes) {
    errors = processOverride(
      contractName,
      errors,
      ['enum-definition', 'struct-definition'],
      `    You are using the \`unsafeAllowCustomTypes\` flag to skip storage checks for structs and enums.\n` +
        `    Make sure you have manually checked the storage layout for incompatibilities.\n`,
    );
  }

  // Process `unsafeAllowLinkedLibraries` flag
  if (unsafeAllowLinkedLibraries) {
    errors = processOverride(
      contractName,
      errors,
      ['external-library-linking'],
      `    You are using the \`unsafeAllowLinkedLibraries\` flag to include external libraries.\n` +
        `    Make sure you have manually checked that the linked libraries are upgrade safe.\n`,
    );
  }

  return errors;
}

function processOverride(
  contractName: string,
  errorsToProcess: ValidationError[],
  overrides: string[],
  message: string,
): ValidationError[] {
  let errors: ValidationError[] = errorsToProcess;
  let exceptionsFound = false;

  errors = errors.filter(error => {
    const isException = overrides.includes(error.kind);
    exceptionsFound = exceptionsFound || isException;
    return !isException;
  });

  if (exceptionsFound) {
    console.error(
      '\n' +
        chalk.keyword('orange').bold('Warning: ') +
        `Potentially unsafe deployment of ${contractName}\n\n` +
        message,
    );
  }

  return errors;
}

export class ValidationErrors extends UpgradesError {
  constructor(contractName: string, readonly errors: ValidationError[]) {
    super(`Contract \`${contractName}\` is not upgrade safe`, () => {
      return errors.map(describeError).join('\n\n');
    });
  }
}

const errorInfo: ErrorDescriptions<ValidationError> = {
  constructor: {
    msg: e => `Contract \`${e.contract}\` has a constructor`,
    hint: 'Define an initializer instead',
    link: 'https://zpl.in/upgrades/error-001',
  },
  delegatecall: {
    msg: () => `Use of delegatecall is not allowed`,
    link: 'https://zpl.in/upgrades/error-002',
  },
  selfdestruct: {
    msg: () => `Use of selfdestruct is not allowed`,
    link: 'https://zpl.in/upgrades/error-003',
  },
  'state-variable-assignment': {
    msg: e => `Variable \`${e.name}\` is assigned an initial value`,
    hint: 'Move the assignment to the initializer',
    link: 'https://zpl.in/upgrades/error-004',
  },
  'state-variable-immutable': {
    msg: e => `Variable \`${e.name}\` is immutable`,
    hint: `Use a constant or mutable variable instead`,
    link: 'https://zpl.in/upgrades/error-005',
  },
  'external-library-linking': {
    msg: e => `Linking external libraries like \`${e.name}\` is not yet supported`,
    hint:
      `Use libraries with internal functions only, or skip this check with the \`unsafeAllowLinkedLibraries\` flag \n` +
      `    if you have manually checked that the libraries are upgrade safe`,
    link: 'https://zpl.in/upgrades/error-006',
  },
  'struct-definition': {
    msg: e => `Defining structs like \`${e.name}\` is not yet supported`,
    hint: `If you have manually checked for storage layout compatibility, you can skip this check with the \`unsafeAllowCustomTypes\` flag`,
    link: 'https://zpl.in/upgrades/error-007',
  },
  'enum-definition': {
    msg: e => `Defining enums like \`${e.name}\` is not yet supported`,
    hint: `If you have manually checked for storage layout compatibility, you can skip this check with the \`unsafeAllowCustomTypes\` flag`,
    link: 'https://zpl.in/upgrades/error-007',
  },
};

function describeError(e: ValidationError): string {
  const info = errorInfo[e.kind];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = [chalk.bold(e.src) + ': ' + info.msg(e as any)];
  if (info.hint) {
    log.push(info.hint);
  }
  if (info.link) {
    log.push(chalk.dim(info.link));
  }
  return log.join('\n    ');
}

export function getErrors(validations: Validations, version: Version): ValidationError[] {
  const [contractName, runValidation] = getContractNameAndRunValidation(validations, version);
  const c = runValidation[contractName];
  return c.errors
    .concat(...c.inherit.map(name => runValidation[name].errors))
    .concat(...c.libraries.map(name => runValidation[name].errors));
}

export function isUpgradeSafe(validations: Validations, version: Version): boolean {
  return getErrors(validations, version).length == 0;
}

function* getConstructorErrors(contractDef: ContractDefinition, decodeSrc: SrcDecoder): Generator<ValidationError> {
  for (const fnDef of findAll('FunctionDefinition', contractDef)) {
    if (fnDef.kind === 'constructor' && ((fnDef.body?.statements.length ?? 0) > 0 || fnDef.modifiers.length > 0)) {
      yield {
        kind: 'constructor',
        contract: contractDef.name,
        src: decodeSrc(fnDef),
      };
    }
  }
}

function* getDelegateCallErrors(
  contractDef: ContractDefinition,
  decodeSrc: SrcDecoder,
): Generator<ValidationErrorOpcode> {
  for (const fnCall of findAll('FunctionCall', contractDef)) {
    const fn = fnCall.expression;
    if (fn.typeDescriptions.typeIdentifier?.match(/^t_function_baredelegatecall_/)) {
      yield {
        kind: 'delegatecall',
        src: decodeSrc(fnCall),
      };
    }
    if (fn.typeDescriptions.typeIdentifier?.match(/^t_function_selfdestruct_/)) {
      yield {
        kind: 'selfdestruct',
        src: decodeSrc(fnCall),
      };
    }
  }
}

function* getStateVariableErrors(
  contractDef: ContractDefinition,
  decodeSrc: SrcDecoder,
): Generator<ValidationErrorWithName> {
  for (const varDecl of contractDef.nodes) {
    if (isNodeType('VariableDeclaration', varDecl)) {
      if (!varDecl.constant && !isNullish(varDecl.value)) {
        yield {
          kind: 'state-variable-assignment',
          name: varDecl.name,
          src: decodeSrc(varDecl),
        };
      }
      if (varDecl.mutability === 'immutable') {
        yield {
          kind: 'state-variable-immutable',
          name: varDecl.name,
          src: decodeSrc(varDecl),
        };
      }
    }
  }
}

function getReferencedLibraryIds(contractDef: ContractDefinition): number[] {
  const implicitUsage = [...findAll('UsingForDirective', contractDef)].map(
    usingForDirective => usingForDirective.libraryName.referencedDeclaration,
  );

  const explicitUsage = [...findAll('Identifier', contractDef)]
    .filter(identifier => identifier.typeDescriptions.typeString?.match(/^type\(library/))
    .map(identifier => {
      if (isNullish(identifier.referencedDeclaration)) {
        throw new Error('Broken invariant: Identifier.referencedDeclaration should not be null');
      }
      return identifier.referencedDeclaration;
    });

  return [...new Set(implicitUsage.concat(explicitUsage))];
}

function* getLinkingErrors(
  contractDef: ContractDefinition,
  bytecode: SolcBytecode,
): Generator<ValidationErrorWithName> {
  const { linkReferences } = bytecode;
  for (const source of Object.keys(linkReferences)) {
    for (const libName of Object.keys(linkReferences[source])) {
      yield {
        kind: 'external-library-linking',
        name: libName,
        src: source,
      };
    }
  }
}

function* getStructErrors(contractDef: ContractDefinition, decodeSrc: SrcDecoder): Generator<ValidationErrorWithName> {
  for (const structDefinition of findAll('StructDefinition', contractDef)) {
    yield {
      kind: 'struct-definition',
      name: structDefinition.name,
      src: decodeSrc(structDefinition),
    };
  }
}

function* getEnumErrors(contractDef: ContractDefinition, decodeSrc: SrcDecoder): Generator<ValidationErrorWithName> {
  for (const enumDefinition of findAll('EnumDefinition', contractDef)) {
    yield {
      kind: 'enum-definition',
      name: enumDefinition.name,
      src: decodeSrc(enumDefinition),
    };
  }
}
