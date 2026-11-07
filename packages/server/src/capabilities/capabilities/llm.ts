import { BadRequestException } from "@nestjs/common";
import type { CapabilityDescriptor } from "../capability.types";
import type { ToolapiService } from "../../toolapi/toolapi.service";

export const llmDescriptors: CapabilityDescriptor[] = [
  {
    name: "llm_text",
    title: "模型生成文本",
    category: "ai",
    description: "把指令 + 输入交给站内模型生成结果（走正常计费：免费额度优先，其次积分），用于改写、总结、写话术",
    params: { instruction: "必填，要模型做什么", input: "可选，素材正文", model: "可选，模型别名；缺省用后台排序第一个" },
  },
];

export function buildLlmHandlers(toolapi: ToolapiService) {
  return {
    llm_text: async ({ phone, params }: any) => {
      if (!phone) throw new BadRequestException("当前账号未绑定手机号，无法使用模型能力");
      const instruction = String(params.instruction || "").trim();
      if (!instruction) throw new BadRequestException("instruction 必填");
      const input = params.input ? String(params.input) : "";
      const prompt = input ? instruction + "\n\n---\n" + input : instruction;
      const text = await toolapi.aiText(phone, prompt, params.model);
      return { model: params.model || null, text };
    },
  };
}
