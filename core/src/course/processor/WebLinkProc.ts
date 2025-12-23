import { Page } from 'playwright';

import { CourseType, Processor } from '../processor.js';

import { waitForSPALoaded } from '../../utils.js';

export default class WebLinkProc implements Processor {
  name: CourseType = 'web_link';

  async exec(page: Page) {
    await waitForSPALoaded(page);

    // 线上链接的页面形态不稳定：有时没有“观看回放”，有时元素存在但不可点击。
    // 这里做 fail-fast，避免长时间卡在 locator action 上。
    const replay = page.getByText('观看回放').first();

    const hasReplay = await replay
      .isVisible({ timeout: 1200 })
      .then(() => true)
      .catch(() => false);

    if (!hasReplay) {
      console.log('不支持: 未找到“观看回放”');
      return;
    }

    try {
      await replay.click({ timeout: 1500, force: true });
      // 点完后给页面一点点时间加载/弹窗渲染，避免后续流程误判
      await page.waitForTimeout(800);
    } catch (e) {
      console.log('不支持: “观看回放”不可点击', (e as Error).message);
    }
  }
}

// https://v.ouchn.cn/live/watch/heartbeat/[liveId]?参数1=值1&参数2=值2&...
// liveId 获取方式 window.originLiveId
// t=时间戳
// tid=xylink-live_58e84848652dbc42955dd239990dd20a

// tid 计算方式
// const c = {
//   "clientType": "xylink-live",
//   "n-ua": "3.10.0"
// }
// const generateRequestId = function(clientType) {
//   return "".concat(clientType, "_").concat(generateUUID())
// }

// const generateUUID = function() {
//   var e = (new Date).getTime();
//   return "xyxxxxxyxxxxyxxxyxxxxxxxxyxxxxxy".replace(/[xy]/g, function(t) {
//    var n = (e + 16 * Math.random()) % 16 | 0;
//    return e = Math.floor(e / 16),
//    ("x" === t ? n : 3 & n | 8).toString(16)
//   })
// }

// console.log(generateRequestId(c.clientType))

// videoType=flv 视频格式
// randomStr=6FQV2WTJXOXCKAF2FX4U8KFOKKMXOME1 随机字符串
// haveVideoSrc=none 视频源
// upvoteCount=0 点赞数
// watchStatus=STAY_VIEW_PAGE	观看状态
// newFingerPrint2Id=987A416F2314FEB4C93208D0D0A2A1D9 指纹

// 获取指纹的接口

// c = n(28)
// d = Object(c.a)(l, 2)

// function d() {
//    return /android|iphone|ipad/.test(c.toLowerCase()) || /Mac|Mac OS/.test(c) ? e : d() && u() && r.a.isStartLiveing ? (console.log("\u5f53\u524d\u4e3awin7\u7cfb\u7edf\u7684ie\uff0c\u4f7f\u7528rtmp\u683c\u5f0f\u64ad\u653e\u3002"),
//    "rtmp") : u() && r.a.isStartLiveing ? (console.log("\u5f53\u524d\u4e3awin10\u7cfb\u7edf\u7684ie\uff0c\u4f7f\u7528m3u8\u683c\u5f0f\u64ad\u653e\u3002"),
//    "m3u8") : window.MediaSource && window.MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"') ? "flv" : e
// }

// videoType: d("m3u8"),
//  Re.get("/api/rest/live-audience/external/xylink/audience/v1", {
//         liveId: e,
//         videoType: t,
//         randomStr: n,
//         areaCode: a,
//         securityKey: Fe.apiGatewayParams.securityKey,
//         token: Fe.heartbeatToken
//     })
//   }

// baseURL: //v.ouchn.cn
// Accept: "application/json, text/plain, */*"
// Aud-Token:
// method: 'get'
// areaCode: null
// randomStr: "YYNIEXES3XY2AZGUXTBYGJ96XD2T9JXW"
// videoType: "flv"
