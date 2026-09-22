/** 领域错误：code 供 API 层映射状态码，message 面向值班员。 */
export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
