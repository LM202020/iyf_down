// iyf.tv 多集下载 —— 签名纯函数层(vv/pub 逆向重写,不依赖 chrome API,浏览器/node 通用)
// 依据 docs/iyf-multi-download-design.md §12.2:
//   vv = md5(publicKey + "&" + 归一化query + "&" + privateKey[0]);pub = publicKey(明文回填)
// 自带 blueimp-md5(仓库 lib 无 md5、MV3 SubtleCrypto 不支持 md5,故必须自带)。
// UMD 挂载:浏览器挂到 self.IYF_SIGN,node 走 module.exports。
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.IYF_SIGN = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ==========================================================================
    // blueimp-md5 —— 标准实现(JavaScript-MD5,MIT/public-domain,含 UTF-8 处理)。
    // 原样引入,勿改算法;仅去掉原库的 AMD/CommonJS 包装,函数体不动。
    // ==========================================================================
    function safeAdd(x, y) {
        const lsw = (x & 0xffff) + (y & 0xffff);
        const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
        return (msw << 16) | (lsw & 0xffff);
    }
    function bitRotateLeft(num, cnt) {
        return (num << cnt) | (num >>> (32 - cnt));
    }
    function md5cmn(q, a, b, x, s, t) {
        return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
    }
    function md5ff(a, b, c, d, x, s, t) {
        return md5cmn((b & c) | (~b & d), a, b, x, s, t);
    }
    function md5gg(a, b, c, d, x, s, t) {
        return md5cmn((b & d) | (c & ~d), a, b, x, s, t);
    }
    function md5hh(a, b, c, d, x, s, t) {
        return md5cmn(b ^ c ^ d, a, b, x, s, t);
    }
    function md5ii(a, b, c, d, x, s, t) {
        return md5cmn(c ^ (b | ~d), a, b, x, s, t);
    }
    function binlMD5(x, len) {
        x[len >> 5] |= 0x80 << (len % 32);
        x[(((len + 64) >>> 9) << 4) + 14] = len;

        let i;
        let olda;
        let oldb;
        let oldc;
        let oldd;
        let a = 1732584193;
        let b = -271733879;
        let c = -1732584194;
        let d = 271733878;

        for (i = 0; i < x.length; i += 16) {
            olda = a;
            oldb = b;
            oldc = c;
            oldd = d;

            a = md5ff(a, b, c, d, x[i], 7, -680876936);
            d = md5ff(d, a, b, c, x[i + 1], 12, -389564586);
            c = md5ff(c, d, a, b, x[i + 2], 17, 606105819);
            b = md5ff(b, c, d, a, x[i + 3], 22, -1044525330);
            a = md5ff(a, b, c, d, x[i + 4], 7, -176418897);
            d = md5ff(d, a, b, c, x[i + 5], 12, 1200080426);
            c = md5ff(c, d, a, b, x[i + 6], 17, -1473231341);
            b = md5ff(b, c, d, a, x[i + 7], 22, -45705983);
            a = md5ff(a, b, c, d, x[i + 8], 7, 1770035416);
            d = md5ff(d, a, b, c, x[i + 9], 12, -1958414417);
            c = md5ff(c, d, a, b, x[i + 10], 17, -42063);
            b = md5ff(b, c, d, a, x[i + 11], 22, -1990404162);
            a = md5ff(a, b, c, d, x[i + 12], 7, 1804603682);
            d = md5ff(d, a, b, c, x[i + 13], 12, -40341101);
            c = md5ff(c, d, a, b, x[i + 14], 17, -1502002290);
            b = md5ff(b, c, d, a, x[i + 15], 22, 1236535329);

            a = md5gg(a, b, c, d, x[i + 1], 5, -165796510);
            d = md5gg(d, a, b, c, x[i + 6], 9, -1069501632);
            c = md5gg(c, d, a, b, x[i + 11], 14, 643717713);
            b = md5gg(b, c, d, a, x[i], 20, -373897302);
            a = md5gg(a, b, c, d, x[i + 5], 5, -701558691);
            d = md5gg(d, a, b, c, x[i + 10], 9, 38016083);
            c = md5gg(c, d, a, b, x[i + 15], 14, -660478335);
            b = md5gg(b, c, d, a, x[i + 4], 20, -405537848);
            a = md5gg(a, b, c, d, x[i + 9], 5, 568446438);
            d = md5gg(d, a, b, c, x[i + 14], 9, -1019803690);
            c = md5gg(c, d, a, b, x[i + 3], 14, -187363961);
            b = md5gg(b, c, d, a, x[i + 8], 20, 1163531501);
            a = md5gg(a, b, c, d, x[i + 13], 5, -1444681467);
            d = md5gg(d, a, b, c, x[i + 2], 9, -51403784);
            c = md5gg(c, d, a, b, x[i + 7], 14, 1735328473);
            b = md5gg(b, c, d, a, x[i + 12], 20, -1926607734);

            a = md5hh(a, b, c, d, x[i + 5], 4, -378558);
            d = md5hh(d, a, b, c, x[i + 8], 11, -2022574463);
            c = md5hh(c, d, a, b, x[i + 11], 16, 1839030562);
            b = md5hh(b, c, d, a, x[i + 14], 23, -35309556);
            a = md5hh(a, b, c, d, x[i + 1], 4, -1530992060);
            d = md5hh(d, a, b, c, x[i + 4], 11, 1272893353);
            c = md5hh(c, d, a, b, x[i + 7], 16, -155497632);
            b = md5hh(b, c, d, a, x[i + 10], 23, -1094730640);
            a = md5hh(a, b, c, d, x[i + 13], 4, 681279174);
            d = md5hh(d, a, b, c, x[i], 11, -358537222);
            c = md5hh(c, d, a, b, x[i + 3], 16, -722521979);
            b = md5hh(b, c, d, a, x[i + 6], 23, 76029189);
            a = md5hh(a, b, c, d, x[i + 9], 4, -640364487);
            d = md5hh(d, a, b, c, x[i + 12], 11, -421815835);
            c = md5hh(c, d, a, b, x[i + 15], 16, 530742520);
            b = md5hh(b, c, d, a, x[i + 2], 23, -995338651);

            a = md5ii(a, b, c, d, x[i], 6, -198630844);
            d = md5ii(d, a, b, c, x[i + 7], 10, 1126891415);
            c = md5ii(c, d, a, b, x[i + 14], 15, -1416354905);
            b = md5ii(b, c, d, a, x[i + 5], 21, -57434055);
            a = md5ii(a, b, c, d, x[i + 12], 6, 1700485571);
            d = md5ii(d, a, b, c, x[i + 3], 10, -1894986606);
            c = md5ii(c, d, a, b, x[i + 10], 15, -1051523);
            b = md5ii(b, c, d, a, x[i + 1], 21, -2054922799);
            a = md5ii(a, b, c, d, x[i + 8], 6, 1873313359);
            d = md5ii(d, a, b, c, x[i + 15], 10, -30611744);
            c = md5ii(c, d, a, b, x[i + 6], 15, -1560198380);
            b = md5ii(b, c, d, a, x[i + 13], 21, 1309151649);
            a = md5ii(a, b, c, d, x[i + 4], 6, -145523070);
            d = md5ii(d, a, b, c, x[i + 11], 10, -1120210379);
            c = md5ii(c, d, a, b, x[i + 2], 15, 718787259);
            b = md5ii(b, c, d, a, x[i + 9], 21, -343485551);

            a = safeAdd(a, olda);
            b = safeAdd(b, oldb);
            c = safeAdd(c, oldc);
            d = safeAdd(d, oldd);
        }
        return [a, b, c, d];
    }
    function binl2rstr(input) {
        let i;
        let output = '';
        const length32 = input.length * 32;
        for (i = 0; i < length32; i += 8) {
            output += String.fromCharCode((input[i >> 5] >>> (i % 32)) & 0xff);
        }
        return output;
    }
    function rstr2binl(input) {
        let i;
        const output = [];
        output[(input.length >> 2) - 1] = undefined;
        for (i = 0; i < output.length; i += 1) {
            output[i] = 0;
        }
        const length8 = input.length * 8;
        for (i = 0; i < length8; i += 8) {
            output[i >> 5] |= (input.charCodeAt(i / 8) & 0xff) << (i % 32);
        }
        return output;
    }
    function rstrMD5(s) {
        return binl2rstr(binlMD5(rstr2binl(s), s.length * 8));
    }
    function rstr2hex(input) {
        const hexTab = '0123456789abcdef';
        let output = '';
        let x;
        let i;
        for (i = 0; i < input.length; i += 1) {
            x = input.charCodeAt(i);
            output += hexTab.charAt((x >>> 4) & 0x0f) + hexTab.charAt(x & 0x0f);
        }
        return output;
    }
    function str2rstrUTF8(input) {
        return unescape(encodeURIComponent(input));
    }
    // 对外:UTF-8 字符串 → 32 位小写十六进制 md5
    function md5(str) {
        return rstr2hex(rstrMD5(str2rstrUTF8(String(str))));
    }

    // ==========================================================================
    // query 归一化 + 签名(§12.2;实现严格复刻 scratchpad verify_*.py 的 get_query/strip_sig)
    // ==========================================================================

    // 取出 URL(或裸 query)里 `?` 之后的 query 串;裸串直接原样返回(去掉可能的前导 ?)。
    function extractQuery(urlOrQuery) {
        if (urlOrQuery === undefined || urlOrQuery === null) { return ''; }
        const s = String(urlOrQuery);
        const i = s.indexOf('?');
        if (i !== -1) { return s.slice(i + 1); }
        // 无 ?:若像完整 URL(含 :// 或 /)则视为无 query;否则当作裸 query
        return s;
    }

    // 单个参数值解码:decodeURIComponent + `+`→空格(顺序、语义对齐 python unquote().replace('+',' '))。
    // 非法百分号序列容错:解码失败则退回原串再做 +→空格。
    function decodeValue(v) {
        let d;
        try {
            d = decodeURIComponent(v);
        } catch (e) {
            d = v;
        }
        return d.replace(/\+/g, ' ');
    }

    // 归一化 query:去掉 vv/pub 两参 → 每个值 decode 且 +→空格 → 保持原顺序 → 整串 toLowerCase。
    // key 本身不解码、不单独处理,随整串最后统一小写。path 不参与。
    function normalizeQuery(urlOrQuery) {
        const q = extractQuery(urlOrQuery);
        if (q === '') { return ''; }
        const kept = [];
        const parts = q.split('&');
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (part === '') { continue; }
            const seg = part.split('=');
            const key = seg[0];
            if (key === 'vv' || key === 'pub') { continue; }
            let s = key;
            for (let j = 1; j < seg.length; j++) {
                s += '=' + decodeValue(seg[j]);
            }
            kept.push(s);
        }
        return kept.join('&').toLowerCase();
    }

    // sign(urlOrQuery, publicKey, privateKey) → {vv, pub}
    // privateKey 传数组时取 [0];传字符串直接用。pub 明文回填 = publicKey。
    function sign(urlOrQuery, publicKey, privateKey) {
        const pub = String(publicKey === undefined || publicKey === null ? '' : publicKey);
        const priv = Array.isArray(privateKey) ? (privateKey.length ? privateKey[0] : '') : privateKey;
        const privStr = String(priv === undefined || priv === null ? '' : priv);
        const normQ = normalizeQuery(urlOrQuery);
        const vv = md5(pub + '&' + normQ + '&' + privStr);
        return { vv: vv, pub: pub };
    }

    return {
        md5,
        normalizeQuery,
        sign,
    };
});

// ---- 自检:node js/iyf-sign.js 退出码 0 即通过 ----
if (typeof require !== 'undefined' && require.main === module) {
    const assert = require('assert');
    const SIGN = module.exports;

    // ---- md5 标准测试向量(RFC 1321)----
    assert.strictEqual(SIGN.md5(''), 'd41d8cd98f00b204e9800998ecf8427e');
    assert.strictEqual(SIGN.md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
    assert.strictEqual(SIGN.md5('message digest'), 'f96b697d7cb7938d525a2f31aaf161d0');

    // ---- 归一化边界 ----
    // 去掉 vv/pub 两参、保持原顺序、整串小写
    assert.strictEqual(
        SIGN.normalizeQuery('https://m10.iyf.tv/api/payment/getPaymentInfo?isPromotion=3&region=DE&vv=abc&pub=123'),
        'ispromotion=3&region=de'
    );
    // 裸 query 输入等价
    assert.strictEqual(SIGN.normalizeQuery('isPromotion=3&region=DE&vv=abc&pub=123'), 'ispromotion=3&region=de');
    // + → 空格,%E4%B8%AD → 中(decodeURIComponent),整串小写
    assert.strictEqual(SIGN.normalizeQuery('a=Hello+World&b=%E4%B8%AD&vv=X&pub=P'), 'a=hello world&b=中');
    // 值中含 = 保留;空输入
    assert.strictEqual(SIGN.normalizeQuery('t=a=b&vv=1&pub=2'), 't=a=b');
    assert.strictEqual(SIGN.normalizeQuery(''), '');
    // 无 ? 的串按裸 query 处理(真实签名 URL 必带 ?,此为裸串入口)
    assert.strictEqual(SIGN.normalizeQuery('A=1&B=2'), 'a=1&b=2');

    // ---- 黄金向量①:真实站点捕获(scratchpad sig_stacks.json / verify_vv.py 实测,OK i=4)----
    // URL: https://m10.iyf.tv/api/payment/getPaymentInfo?isPromotion=3&region=DE&vv=...&pub=1788194763980
    // 归一化 query = "ispromotion=3&region=de";priv[0]="vcrsion001";pub="1788194763980"
    const g1 = SIGN.sign(
        'https://m10.iyf.tv/api/payment/getPaymentInfo?isPromotion=3&region=DE&vv=b2491a91b01a7cb39595806efae8eebc&pub=1788194763980',
        '1788194763980',
        ['vcrsion001']
    );
    assert.strictEqual(g1.vv, 'b2491a91b01a7cb39595806efae8eebc'); // 精确匹配站点真实 vv
    assert.strictEqual(g1.pub, '1788194763980');
    // 直接给 md5 拼串也应等价(证明归一化 + 拼接顺序无误)
    assert.strictEqual(
        SIGN.md5('1788194763980&ispromotion=3&region=de&vcrsion001'),
        'b2491a91b01a7cb39595806efae8eebc'
    );

    // ---- 黄金向量②:UTF-8 + `+`解码 归一化(python md5 over utf-8 预算)----
    // o = "P&a=hello world&b=中&k"
    const g2 = SIGN.sign('https://x/api?a=Hello+World&b=%E4%B8%AD&vv=zzz&pub=P', 'P', ['k']);
    assert.strictEqual(g2.vv, '116fcbcfd757f0056571f9f95730d355');
    assert.strictEqual(g2.pub, 'P');

    // privateKey 传字符串与传单元素数组等价
    assert.strictEqual(SIGN.sign('a=1', 'P', 'k').vv, SIGN.sign('a=1', 'P', ['k']).vv);

    console.log('iyf-sign self-check: all assertions passed');
}
