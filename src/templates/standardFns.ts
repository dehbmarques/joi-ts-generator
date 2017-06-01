// tslint:disable:no-var-requires
import * as joi from "joi";
const freeze = require("deep-freeze-strict");

const defaultOptions: joi.ValidationOptions = {
  allowUnknown: true,
  convert: true,
  presence: "optional",
  stripUnknown: true,
};

export function coerceFactory<T>(factory: Factory.IFactory, schema: joi.Schema) {
  return (attrs?: any, options?: any): T =>
    coerceValue<T>(schema)(factory.build(attrs, options));
}

export function coerceValue<T>(schema: joi.Schema) {
  return (object: any, options?: any): T => {
    const resolvedOptions = Object.assign({}, defaultOptions, options);
    let coerced: any;

    joi.validate(object, schema, resolvedOptions, (err, result) => {
      if (err) { throw err; }
      coerced = result;
    });

    return freeze(coerced) as T;
  };
}
