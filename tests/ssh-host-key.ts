import ssh2 from "ssh2";

/**
 * 測試用的 SSH 主機金鑰。ssh2 自己產生的 ed25519 金鑰約百分之一無法被它解析
 * （「Malformed OpenSSH private key」），直接拿來建 Server 會讓測試偶發失敗，所以重產到可解析為止。
 */
export function testHostKey() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const key = ssh2.utils.generateKeyPairSync("ed25519");
    if (!(ssh2.utils.parseKey(key.private) instanceof Error)) return key;
  }
  throw new Error("無法產生可用的測試主機金鑰");
}
