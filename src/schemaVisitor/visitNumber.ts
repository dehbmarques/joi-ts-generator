import { none, some } from "fp-ts/lib/Option";

import { nameFromNotes } from "./naming";

import { BasicType, VisitedType, Visitor } from "./types";

export const visitNumber: Visitor = visitSchema => schema => {
  if (schema._type !== "number") {
    return none;
  }

  const basicType: BasicType = {
    kind: "basic",
    type: "number",
  };

  const type: VisitedType = {
    class: basicType,
    name: nameFromNotes(schema),
  };

  return some(type);
};
