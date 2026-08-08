import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";

export default defineTool({
  description: "First step. Returns the code that step_two requires.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  approval: always(),
  execute() {
    return { code: "alpha-7" };
  },
});
