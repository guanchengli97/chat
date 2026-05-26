# WeChat-like Chat MVP

网页版基础聊天应用，前端使用 React + TypeScript，后端使用 AWS Amplify Gen 2 Serverless 资源。

## 架构

- React + TypeScript + Vite
- Amazon Cognito：注册、登录、退出
- AWS AppSync GraphQL：数据 API 与实时订阅
- DynamoDB：Amplify Data 模型持久化
- S3：头像和后续图片消息文件
- Lambda：Cognito post-confirmation 触发器骨架
- Amplify Hosting：前端部署

## 已实现功能

- 用户注册、登录、退出
- 用户资料初始化、昵称编辑、头像上传
- 用户搜索与添加联系人
- 创建一对一聊天
- 发送文字消息
- `observeQuery` 实时订阅消息和联系人更新
- 聊天记录通过 Amplify Data/AppSync 持久化到 DynamoDB
- 左侧联系人列表、右侧聊天窗口的基础 UI

## 本地开发

安装依赖：

```bash
npm install
```

启动 Amplify Gen 2 沙箱，生成真实的 `amplify_outputs.json`：

```bash
npm run sandbox
```

另开一个终端启动前端：

```bash
npm run dev
```

> 仓库中自带的 `amplify_outputs.json` 是为了让 TypeScript/Vite 能在没有云资源时通过构建的占位文件。连接 AWS 时请使用 `ampx sandbox` 或 Amplify Hosting 构建流程生成的真实输出文件。

## 部署到 Amplify Hosting

1. 将项目推送到 GitHub/GitLab/Bitbucket。
2. 在 AWS Amplify 创建 Gen 2 应用并连接仓库。
3. 构建命令使用 `npm run build`。
4. Amplify 会根据 `amplify/` 目录部署 Cognito、AppSync、DynamoDB、S3、Lambda 并生成前端输出配置。

## 后续建议

- 将联系人和会话授权收紧为仅会话成员可读写。
- 增加图片消息发送与预览。
- 增加未读数、消息发送失败重试、联系人备注。
- 使用 Lambda 在注册后自动创建 `UserProfile`，并通过 AppSync IAM 或 Data Client 权限写入数据。
