/**
 * 极简 XML 工具：企微 / 公众号回调报文都是「一层扁平 XML」（<xml> 下直接挂字符串节点），
 * 用不到完整的 XML 解析器，所以这里用正则实现，避免引入第三方依赖。
 *
 * 注意：
 * - 文本节点可能是 <![CDATA[...]]>，解析时统一剥离；
 * - 回复时统一用 CDATA 包裹，并处理 "]]>" 这种会截断 CDATA 的边界情况。
 */

/** 解析 <xml><A>1</A><B><![CDATA[x]]></B></xml> → { A: "1", B: "x" } */
export function parseFlatXml(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!xml) return out;
  // 先去掉最外层 <xml> 包装，避免根节点把整段报文吞掉
  const inner = String(xml)
    .replace(/^\s*<xml[^>]*>/i, "")
    .replace(/<\/xml>\s*$/i, "");
  const re = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(inner))) {
    let value = match[2] ?? "";
    const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value);
    if (cdata) value = cdata[1];
    out[match[1]] = value;
  }
  return out;
}

/** XML 文本转义（用于非 CDATA 节点） */
export function xmlEscape(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 生成 CDATA 节点内容，安全处理 "]]>" 截断 */
export function cdata(value: string): string {
  return "<![CDATA[" + String(value ?? "").replace(/]]>/g, "]]]]><![CDATA[>") + "]]>";
}

/**
 * 被动回复 XML（明文）
 * 被动回复要求 ToUserName / FromUserName 与来消息互换（官方文档「被动回复消息」）。
 */
export function buildPassiveReplyXml(
  toUser: string,
  fromUser: string,
  content: string,
  createTime: number = Math.floor(Date.now() / 1000),
): string {
  return (
    "<xml>" +
    "<ToUserName>" + cdata(toUser) + "</ToUserName>" +
    "<FromUserName>" + cdata(fromUser) + "</FromUserName>" +
    "<CreateTime>" + createTime + "</CreateTime>" +
    "<MsgType>" + cdata("text") + "</MsgType>" +
    "<Content>" + cdata(content) + "</Content>" +
    "</xml>"
  );
}
