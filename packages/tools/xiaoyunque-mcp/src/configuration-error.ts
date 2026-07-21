const missingAuthorizationMessage =
  "XiaoYunque is not authorized. Open Convax Services and authorize XiaoYunque before generating." as const

export class XiaoYunqueCredentialConfigurationError extends Error {
  override readonly name = "XiaoYunqueCredentialConfigurationError"

  constructor(readonly publicMessage = missingAuthorizationMessage) {
    super(publicMessage)
  }
}
