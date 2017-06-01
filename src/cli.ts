#!/usr/bin/env ts-node

import fs = require("fs");
import * as joi from "joi";
import { find, get, has, identity, isObject, map, mapKeys, pick, pickBy, reduce, some } from "lodash";
import * as path from "path";
import { Factory } from "rosie";

// tslint:disable-next-line:no-var-requires
const readPkgUp = require("read-pkg-up");

import typeTemplate, { baseTemplate } from "./coercionTemplate";

const packageJson = readPkgUp.sync();

if (!packageJson.pkg) {
  throw new Error(`Could not find package.json in: ${process.cwd()}`);
}

const configSchema = joi.object().keys({
  joiTsGenerator: joi.object().keys({
    input: joi.string().required(),
    outputs: joi.object().keys({
      library: joi.string().required(),
      types: joi.string().required(),
      utils: joi.string().required(),
    }).required(),
  }).required(),
});

const { error, value } = joi.validate(packageJson.pkg, configSchema, { allowUnknown: true });

if (error) {
  throw error;
}

const config = value.joiTsGenerator;
const projectPath = path.dirname(packageJson.path);
const inputPath = path.join(projectPath, config.input);
const libraryPath = path.join(projectPath, config.outputs.library);
const typesPath = path.join(projectPath, config.outputs.types);
const utilsPath = path.join(projectPath, config.outputs.utils);
const useOptionTypes = config.useOptionTypes;

// tslint:disable-next-line:no-var-requires
const objects = require(inputPath);

interface IDiscoverableType {
  name: string;
  type?: string;
  skip?: boolean;
}
interface IFactories { [k: string]: Factory.IFactory; }
interface IJoiSchema extends joi.Schema {
  _type: string;
  _notes: string[];
}
interface ISchemae { [k: string]: IJoiSchema; }

const discoveredTypes: IDiscoverableType[] = [];
const schemaCheck = /Schema$/;
const typeCheck = /^type:/;

const addDiscoveredType = (type: IDiscoverableType) => {
  if (!find(discoveredTypes, ["name", type.name])) {
    discoveredTypes.push(type);
  }
};

const usableNotes = ({ _notes }: any): boolean => !!(_notes || []).find((n: any) => typeCheck.test(n));
const isRequiredSchema = (schema: any) => (get(schema, "_flags.presence", "optional") as string === "required");
const getUnion = (node: any): any[] => Array.from(get(node, "_valids._set", []));
const propName = ({ key, schema }: any): string => (isRequiredSchema(schema) || useOptionTypes) ? key : `${key}?`;

const joiToTypescript = (type: string) => {
  switch (type) {
    case "date":
      return "Date";
    default:
      return type;
  }
};

const unwrapArray = ({ _inner: { items } }: any): string => {
  const [item, ...rest] = items;
  if (some(rest)) {
    return `Array<${items.map(deriveType).join(" | ")}>`;
  }

  return `${deriveType(item)}[]`;
};

const nameFromNotes = (notes: string[]): string => {
  const note = notes.find(n => typeCheck.test(n));
  if (!note) { throw new Error("Must provide type information through notes."); }

  return note.replace(typeCheck, "");
};

const unwrapNotes = (type: string, notes: string[]): string => {
  const name = nameFromNotes(notes);
  addDiscoveredType({ name, type });

  return name;
};

const alternativesCheck = (schema: any): boolean => schema._type === "alternatives";
const uuidCheck = (schema: any): boolean => !!get(schema, "_tests", []).find((t: any) => get(t, "name") === "guid");

const optionTypeWrapper = (type: string) => `Option<${type}>`;

const deriveType = (schema: any) => {
  if (schema._type === "array") { return unwrapArray(schema); }
  if (usableNotes(schema)) { return unwrapNotes(schema._type, schema._notes); }
  if (uuidCheck(schema)) {
    addDiscoveredType({ name: "Uuid", type: "string" });
    return "Uuid";
  }
  if (alternativesCheck(schema)) {
    const types = schema._inner.matches.map((type: any) => deriveType(type.schema));
    return types.join(" | ");
  }
  return joiToTypescript(schema._type);
};

const resolveTypeDefinition = (node: any): string => {
  if (typeof node === "string") { return ` ${node}`; }
  const baseType = node._type;
  const options = getUnion(node);
  const out: string[] = [];

  if (options.length) {
    options.forEach((opt: any) => {
      const candidate = baseType === "string" ? `"${opt}"` : opt;
      if (out.indexOf(candidate) === -1) { out.push(candidate); }
    });

    return out.map(str => `\n  | ${str}`).join("");
  }

  return ` ${joiToTypescript(baseType)}`;
};

const writeInterfaceType = (typeName: string, { _inner: { children }}: any): string =>
`export interface ${typeName} {
${children.map((child: any) => {
  const wrap = (!isRequiredSchema(child.schema) && useOptionTypes) ? optionTypeWrapper : identity;
  return `  ${propName(child)}: ${wrap(deriveType(child.schema))};`;
}).join("\n")}
}`;

const writeTypeAlias = (typeName: string, type: string): string =>
  `export type ${typeName} =${resolveTypeDefinition(type)};`;

const typeWriters: any = {
  array: writeTypeAlias,
  object: writeInterfaceType,
  string: writeTypeAlias,
};

const schemaNameCheck = (val: IJoiSchema, name: string) => schemaCheck.test(name);

const transposeSchemaTypes = (res: ISchemae, val: IJoiSchema, key: string): ISchemae =>
  ({ ...res, [key.replace(schemaCheck, "")]: val });

const relativeImportPath = (from: string, to: string) => {
  const p = path.relative(path.dirname(from), to).replace(/\.ts$/, "");
  return (p.charAt(0) === ".") ? p : `./${p}`;
};

const runTypeGenerator = () => {
  const exported = objects as any;

  const filteredTypes = pickBy(exported, schemaNameCheck) as any;
  const schemaTypes = reduce(filteredTypes, transposeSchemaTypes, {});
  const factoryTypes = Object.keys(schemaTypes).filter(name => has(exported, `${name}Factory`));

  const schemaOutput: string[] = map(schemaTypes, (schema, name) => {
    const writer = typeWriters[schema._type];
    addDiscoveredType({ name, skip: true });
    if (!schema._notes.find(n => n === `type:${name}`)) {
      schema._notes.push(`type:${name}`);
    }
    return writer(name, schema);
  });

  discoveredTypes
    .filter(t => !t.skip)
    .forEach(type => schemaOutput.unshift(writeTypeAlias(type.name, type.type)));

  if (useOptionTypes) {
    schemaOutput.unshift("import { Option } from \"fp-ts/lib/Option\";");
  }

  const coerceOutput: string[] = Object.keys(schemaTypes).map(type =>
    typeTemplate(type, factoryTypes.some(n => n === type)));

  const relativePathToLibrary = relativeImportPath(utilsPath, libraryPath);
  const relativePathToInput = relativeImportPath(utilsPath, inputPath);
  const relativePathToTypes = relativeImportPath(utilsPath, typesPath);

  coerceOutput.unshift(
    baseTemplate(
      useOptionTypes,
      relativePathToLibrary,
      relativePathToInput,
      relativePathToTypes));

  const fnsFile = useOptionTypes ? "optionTypeFns.ts" : "standardFns.ts";
  const fnsContent = fs.readFileSync(path.resolve(__dirname, "templates", fnsFile), "UTF-8");

  fs.writeFileSync(libraryPath, fnsContent);
  fs.writeFileSync(typesPath, `${schemaOutput.join("\n\n")}\n`);
  fs.writeFileSync(utilsPath, `${coerceOutput.join("\n\n")}\n`);
};

runTypeGenerator();
