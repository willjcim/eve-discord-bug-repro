import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";

// `code` is only knowable from step_one's result, so the model cannot batch
// both calls into one parallel step. The two approval prompts are always
// sequential, which is what this repro needs.
export default defineTool({
  description: "Second step. Requires the code returned by step_one.",
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string", description: "The code returned by step_one." },
    },
    required: ["code"],
    additionalProperties: false,
  },
  approval: always(),
  execute() {
    return { ok: true };
  },
});
