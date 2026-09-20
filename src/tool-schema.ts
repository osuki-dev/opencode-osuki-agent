import { Schema } from "effect"

// Pass JSON across the host boundary; decode with this runtime's Effect Schema.
// Code Mode cannot safely interpret refinements from a plugin-local Effect AST.
export function toolInputSchema(schema: Schema.Constraint) {
  const document = Schema.toJsonSchemaDocument(schema)
  return { ...document.schema, $defs: document.definitions }
}
