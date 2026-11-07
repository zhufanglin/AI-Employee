# 公众号CLI配置

## 客户负责的配置

1. 在公众号后台取得AppID和AppSecret，并确认账号具备草稿/发布接口权限。
2. 配置公众号后台的IP白名单。
3. 在本机环境变量中设置，不要写进项目文件：

```bash
export WECHAT_APP_ID="..."
export WECHAT_APP_SECRET="..."
```

4. 封面图先通过客户现有公众号工具上传，取得永久素材`thumb_media_id`。

## article.json

```json
{
  "title": "文章标题",
  "author": "作者",
  "digest": "摘要",
  "content_html_file": "/absolute/article.html",
  "content_source_url": "",
  "thumb_media_id": "客户上传封面后得到的media_id",
  "need_open_comment": 0,
  "only_fans_can_comment": 0
}
```

## 命令

```bash
python .agents/skills/boss-wechat-publisher/scripts/wechat_cli.py check
python .agents/skills/boss-wechat-publisher/scripts/wechat_cli.py draft --article /absolute/article.json --confirm DRAFT
python .agents/skills/boss-wechat-publisher/scripts/wechat_cli.py publish --media-id MEDIA_ID --confirm PUBLISH
python .agents/skills/boss-wechat-publisher/scripts/wechat_cli.py status --publish-id PUBLISH_ID
```

接口权限和返回码可能随公众号类型与平台规则变化。遇到接口报错时保留原始错误码并在公众号官方文档中核验，不猜测成功。
