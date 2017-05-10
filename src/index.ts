#!/usr/bin/env ts-node

import fs = require("fs");
import { find, get, pick, some } from "lodash";

const argv: string[] = process.argv;

const sourcePath: string = argv[2];
const destPath: string = argv[3];

if (!sourcePath && !destPath) { process.exit(1); }

// tslint:disable-next-line:no-var-requires
const objects = require(sourcePath);

interface IDiscoverableType {
  name: string;
  type?: string;
  skip?: boolean;
}

const discoveredTypes: IDiscoverableType[] = [];
const typeCheck = /^type:/;

const addDiscoveredType = (type: IDiscoverableType) => {
  if (discoveredTypes.find((typ: IDiscoverableType) => typ.name === type.name)) { return; }
  discoveredTypes.push(type);
};

const usableNotes = ({ _notes }: any): boolean => !!(_notes || []).find((n: any) => typeCheck.test(n));

const getUnion = (node: any): any[] => Array.from(get(node, "_valids._set", []));
const propName = ({ key, schema }: any): string =>
  (get(schema, "_flags.presence", "optional") as string === "required") ? key : `${key}?`;

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

const uuidCheck = (schema: any): boolean =>
  !!schema._tests.find((t: any) => t.name === "guid");

const deriveType = (schema: any) => {
  if (schema._type === "array") { return unwrapArray(schema); }
  if (usableNotes(schema)) { return unwrapNotes(schema._type, schema._notes); }
  if (uuidCheck(schema)) {
    addDiscoveredType({ name: "Uuid", type: "string" });
    return "Uuid";
  }
  return joiToTypescript(schema._type);
};

const resolveTypeDefinition = (node: any): string => {
  if (typeof node === "string") { return node; }
  const baseType = node._type;
  const options = getUnion(node);
  const out: string[] = [];

  if (options.length) {
    options.forEach((opt: any) => {
      const candidate = baseType === "string" ? `"${opt}"` : opt;
      if (out.indexOf(candidate) === -1) { out.push(candidate); }
    });
  } else {
    out.push(joiToTypescript(baseType));
  }

  return out.join(" | ");
};

const writeInterfaceType = (typeName: string, { _inner: { children }}: any): string =>
`export interface ${typeName} {
${children.map((child: any) => `  ${propName(child)}: ${deriveType(child.schema)};`).join("\n")}
}`;

const writeTypeAlias = (typeName: string, type: string): string =>
  `export type ${typeName} = ${resolveTypeDefinition(type)};`;

const typeWriters: any = {
  array: writeTypeAlias,
  object: writeInterfaceType,
  string: writeTypeAlias,
};

const runTypeGenerator = () => {
  const output: string[] = Object
    .keys((objects as any))
    .map((typeName: string) => {
      const type: any = (objects as any)[typeName];
      if (usableNotes(type)) {
        const name = nameFromNotes(type._notes);
        const writer = typeWriters[type._type];
        addDiscoveredType({ name, skip: true });
        return writer(name, type);
      }
      return "";
    });

  discoveredTypes
    .filter(t => !t.skip)
    .forEach(type => output.unshift(writeTypeAlias(type.name, type.type)));

  fs.writeFileSync(destPath, output.join("\n\n"));
};

runTypeGenerator();
