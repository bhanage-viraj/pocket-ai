// Builds the JSON schema for the classify+extract call from the task registry.
// llama.cpp turns it into a grammar, so the model can ONLY output one of these shapes:
//   {"intent":"save_resource","project":...,"topic":...} | {"intent":"chat"} | ...
// "intent" is the first property, so the model decides the intent before extracting fields.

const stripDescriptions = (props) =>
  Object.fromEntries(
    Object.entries(props).map(([k, v]) => {
      const { description, grounded, ...rest } = v; // our own keys, not JSON schema
      return [k, rest];
    }),
  );

export function buildIntentSchema(tasks) {
  return {
    anyOf: tasks.map((task) => ({
      type: 'object',
      properties: { intent: { const: task.name }, ...stripDescriptions(task.fields || {}) },
      required: ['intent', ...Object.keys(task.fields || {})],
      additionalProperties: false,
    })),
  };
}
