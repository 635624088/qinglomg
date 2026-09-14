// ============================================================
// wcs.js — WeChatServer 微信 code 服务客户端（YYB Go 兼容版）
// 由 WorkBuddy 补写，替代脚本包中缺失的配套文件。
// 接口对接 yyb_go_pure 服务：
//   GET  {base}/accounts          -> 账号列表
//   POST {base}/wxapp/getCode     -> {ref: openid, app_id} 换微信 code
// 用法: const WeChatServer = require("./wcs.js");
// ============================================================
const axios = require("axios");

const DEFAULT_BASE = process.env.YYB_BASE_URL || "http://172.17.0.1:18080";

class WeChatServer {
  constructor(options = {}) {
    this.appid = options.appid || "";
    this.baseUrl = options.baseUrl || options.base || process.env.YYB_BASE_URL || DEFAULT_BASE;
    // 兼容 YYB_GO 多行格式（地址@账号标识），取第一个地址
    try {
      const go = (process.env.YYB_GO || "").trim();
      if (go && !this.baseUrl || this.baseUrl === DEFAULT_BASE && go) {
        const first = go.split("\n")[0].split("@")[0].trim();
        if (first) {
          this.baseUrl = first.startsWith("http") ? first : "http://" + first;
        }
      }
    } catch (e) { /* ignore */ }
    this.baseUrl = this.baseUrl.replace(/\/+$/, "");
  }

  /** 获取可执行账号列表 */
  async getAccounts() {
    try {
      const resp = await axios.get(this.baseUrl + "/accounts", { timeout: 10000 });
      const d = resp.data;
      if (d && d.code === 0 && Array.isArray(d.data)) {
        return d.data
          .map((acc) => ({
            openid: acc.openid || acc.wxid || "",
            wxid: acc.openid || acc.wxid || "",
            nickname: acc.nickname || acc.alias || acc.remark || acc.openid || "未知",
            remark: acc.nickname || acc.alias || acc.openid || "",
          }))
          .filter((a) => a.openid);
      }
      console.log(`❌ [wcs] /accounts 返回异常: ${JSON.stringify(d).slice(0, 200)}`);
      return [];
    } catch (e) {
      console.log(`❌ [wcs] 获取账号列表失败: ${e.message}`);
      return [];
    }
  }

  /** 通过 openid 获取微信 code */
  async getCode(openid) {
    try {
      const resp = await axios.post(
        this.baseUrl + "/wxapp/getCode",
        { ref: openid, app_id: this.appid },
        { timeout: 20000, headers: { "Content-Type": "application/json" } }
      );
      const d = resp.data;
      if (d && d.code === 0) {
        const inner = d.data || {};
        const realCode = (inner.result && inner.result.code) || inner.code || "";
        if (!realCode) {
          console.log(`❌ [wcs] 服务端未返回 code: ${JSON.stringify(d).slice(0, 200)}`);
        }
        // 把真实 code 放到所有脚本可能读取的位置
        return { data: { code: realCode, data: { code: realCode }, result: inner.result || {} } };
      }
      console.log(`❌ [wcs] getCode 失败: ${JSON.stringify(d).slice(0, 200)}`);
      return { data: d, code: "" };
    } catch (e) {
      console.log(`❌ [wcs] 获取code失败: ${e.message}`);
      return { data: null, code: "" };
    }
  }

  /** 兼容某些脚本可能调用的别名 */
  async getWxCode(openid) {
    return this.getCode(openid);
  }
}

module.exports = WeChatServer;
