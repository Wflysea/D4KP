# -*- coding: utf-8 -*-
"""
4K图片批量下载器 (4kdesk.com)
================================
纯标准库实现，无第三方依赖。
- 下载使用 Windows 内置 WinHTTP（系统组件，无需打包 OpenSSL，体积小）
- 本地界面使用极简 raw-socket HTTP 服务（不依赖 http.server / ssl）
- 单文件打包后约 5MB

用法：
  直接运行：python image_downloader.py
  自检测试：python image_downloader.py --selftest
  打包：    pyinstaller --onefile --windowed --name 4kdownloader (见 build.bat)
"""

import os
import re
import sys
import json
import time
import socket
import threading
import webbrowser
from queue import Queue, Empty

try:
    import ctypes
    from ctypes import wintypes
except Exception:
    ctypes = None

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

# ---------------------------------------------------------------------------
# 全局任务状态
# ---------------------------------------------------------------------------
STATE_LOCK = threading.Lock()
task = None
server_ref = None


class Task:
    def __init__(self):
        self.total = 0
        self.done = 0
        self.failed = 0
        self.running = False
        self.stop = False
        self.current = ""
        self.log = []
        self.folder = ""
        self.thread_count = 8

    def add_log(self, msg):
        with STATE_LOCK:
            line = time.strftime("%H:%M:%S ") + msg
            self.log.append(line)
            if len(self.log) > 300:
                self.log.pop(0)

    def snapshot(self):
        with STATE_LOCK:
            return {
                "total": self.total,
                "done": self.done,
                "failed": self.failed,
                "running": self.running,
                "stop": self.stop,
                "current": self.current,
                "log": list(self.log),
                "folder": self.folder,
            }


# ---------------------------------------------------------------------------
# HTTP 客户端：Windows 内置 WinHTTP（不打包 OpenSSL）
# ---------------------------------------------------------------------------
_winhttp = None
try:
    _winhttp = ctypes.windll.winhttp
    # 设置函数原型（64 位下 HINTERNET 是指针，必须声明 restype）
    _winhttp.WinHttpOpen.restype = ctypes.c_void_p
    _winhttp.WinHttpOpen.argtypes = [wintypes.LPCWSTR, wintypes.DWORD,
                                      wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]
    _winhttp.WinHttpConnect.restype = ctypes.c_void_p
    _winhttp.WinHttpConnect.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR,
                                        wintypes.USHORT, wintypes.DWORD]
    _winhttp.WinHttpOpenRequest.restype = ctypes.c_void_p
    _winhttp.WinHttpOpenRequest.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR,
                                            wintypes.LPCWSTR, wintypes.LPCWSTR,
                                            wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]
    _winhttp.WinHttpSendRequest.restype = wintypes.BOOL
    _winhttp.WinHttpSendRequest.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR,
                                            wintypes.DWORD, ctypes.c_void_p,
                                            wintypes.DWORD, wintypes.DWORD, wintypes.DWORD]
    _winhttp.WinHttpReceiveResponse.restype = wintypes.BOOL
    _winhttp.WinHttpReceiveResponse.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    _winhttp.WinHttpQueryDataAvailable.restype = wintypes.BOOL
    _winhttp.WinHttpQueryDataAvailable.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD)]
    _winhttp.WinHttpReadData.restype = wintypes.BOOL
    _winhttp.WinHttpReadData.argtypes = [ctypes.c_void_p, ctypes.c_void_p,
                                         wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    _winhttp.WinHttpCloseHandle.restype = wintypes.BOOL
    _winhttp.WinHttpCloseHandle.argtypes = [ctypes.c_void_p]
    _winhttp.WinHttpSetOption.restype = wintypes.BOOL
    _winhttp.WinHttpSetOption.argtypes = [ctypes.c_void_p, wintypes.DWORD,
                                          ctypes.c_void_p, wintypes.DWORD]
except Exception:
    _winhttp = None

_WINHTTP_FLAG_SECURE = 0x00800000


def _parse_url(url):
    if "://" not in url:
        url = "http://" + url
    scheme, rest = url.split("://", 1)
    if "/" in rest:
        hostport, path = rest.split("/", 1)
        path = "/" + path
    else:
        hostport, path = rest, "/"
    if ":" in hostport:
        host, portstr = hostport.rsplit(":", 1)
        port = int(portstr)
    else:
        host = hostport
        port = 443 if scheme.lower() == "https" else 80
    if not path:
        path = "/"
    return scheme.lower(), host, port, path


def winhttp_get(url, referer="", timeout=30):
    """使用 WinHTTP 获取 URL 内容，返回 bytes。"""
    if _winhttp is None:
        raise RuntimeError("WinHTTP 不可用，仅支持 Windows 系统")
    scheme, host, port, path = _parse_url(url)
    secure = (scheme == "https")

    hSession = _winhttp.WinHttpOpen("4kdl/1.0", 0, None, None, 0)
    if not hSession:
        raise RuntimeError("WinHttpOpen 失败")
    # 忽略证书错误（公共网络更稳妥）
    try:
        flag = ctypes.c_uint32(0x0000B200)
        _winhttp.WinHttpSetOption(hSession, 31, ctypes.byref(flag), 4)
    except Exception:
        pass
    # 超时（毫秒）
    try:
        to = ctypes.c_uint32(max(1, int(timeout)) * 1000)
        _winhttp.WinHttpSetOption(hSession, 3, ctypes.byref(to), 4)  # CONNECT
        _winhttp.WinHttpSetOption(hSession, 2, ctypes.byref(to), 4)  # RECEIVE
    except Exception:
        pass

    hConnect = _winhttp.WinHttpConnect(hSession, host, port, 0)
    if not hConnect:
        _winhttp.WinHttpCloseHandle(hSession)
        raise RuntimeError("连接失败: " + host)

    hRequest = _winhttp.WinHttpOpenRequest(
        hConnect, "GET", path, None, None, None,
        _WINHTTP_FLAG_SECURE if secure else 0)
    if not hRequest:
        _winhttp.WinHttpCloseHandle(hConnect)
        _winhttp.WinHttpCloseHandle(hSession)
        raise RuntimeError("创建请求失败")

    headers = "Accept: */*\r\n"
    if referer:
        headers += "Referer: %s\r\n" % referer
    _winhttp.WinHttpSendRequest(hRequest, headers, -1, None, 0, 0, 0)
    _winhttp.WinHttpReceiveResponse(hRequest, None)

    data = bytearray()
    avail = wintypes.DWORD(0)
    while True:
        if not _winhttp.WinHttpQueryDataAvailable(hRequest, ctypes.byref(avail)):
            break
        n = avail.value
        if n == 0:
            break
        buf = ctypes.create_string_buffer(n)
        rd = wintypes.DWORD(0)
        if not _winhttp.WinHttpReadData(hRequest, buf, n, ctypes.byref(rd)):
            break
        if rd.value == 0:
            break
        data += buf.raw[:rd.value]

    _winhttp.WinHttpCloseHandle(hRequest)
    _winhttp.WinHttpCloseHandle(hConnect)
    _winhttp.WinHttpCloseHandle(hSession)
    return bytes(data)


def fetch_text(url, referer="", timeout=30):
    data = winhttp_get(url, referer, timeout)
    for enc in ("utf-8", "gbk", "gb18030"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="ignore")


# ---------------------------------------------------------------------------
# URL 拼接（不依赖 urllib）
# ---------------------------------------------------------------------------
def _urljoin(base, link):
    if link.startswith("http://") or link.startswith("https://"):
        return link
    if link.startswith("//"):
        scheme = base.split("://", 1)[0]
        return scheme + "://" + link[2:]
    if link.startswith("/"):
        scheme, rest = base.split("://", 1)
        host = rest.split("/", 1)[0]
        return scheme + "://" + host + link
    base_dir = base.rsplit("/", 1)[0]
    return base_dir + "/" + link


# ---------------------------------------------------------------------------
# 解析规则
# ---------------------------------------------------------------------------
RE_DETAIL_IMG = re.compile(
    r'href="[^"]*DownSys/DownSoft[^"]*"[^>]*>\s*<img[^>]+src="([^"]+)"', re.I)
RE_DETAIL_IMG_FALLBACK = re.compile(
    r'https?://c\.53326\.com/d/file/lan[^\s"\'<>]+\.(?:jpg|jpeg|png)', re.I)
RE_ITEM_LINK = re.compile(
    r'<a\b(?=[^>]*\bclass="item")(?=[^>]*\bhref="([^"]+)")[^>]*>', re.I)
RE_NEXT = re.compile(r'href="([^"]+)"[^>]*>\s*下一页\s*</a>', re.I)
RE_LIST_IMG = re.compile(
    r'data-original="([^"]*c\.53326\.com[^"]+\.(?:jpg|jpeg|png))"', re.I)


def parse_detail_image(html):
    m = RE_DETAIL_IMG.search(html)
    if m:
        return m.group(1)
    m = RE_DETAIL_IMG_FALLBACK.search(html)
    if m:
        return m.group(1)
    return None


def parse_listing(html, base_url):
    detail_urls = []
    for m in RE_ITEM_LINK.finditer(html):
        detail_urls.append(_urljoin(base_url, m.group(1)))
    nxt = None
    nm = RE_NEXT.search(html)
    if nm:
        nxt = _urljoin(base_url, nm.group(1))
    return detail_urls, nxt


def parse_listing_images(html):
    return [m.group(1) for m in RE_LIST_IMG.finditer(html)]


# ---------------------------------------------------------------------------
# 下载核心
# ---------------------------------------------------------------------------
def sanitize_filename(name):
    name = os.path.basename(name.split("?")[0])
    name = re.sub(r'[\\/:*?"<>|]', "_", name)
    if not name:
        name = "image.jpg"
    return name


def download_one(url, folder, referer, task):
    if task.stop:
        return False
    fname = sanitize_filename(url)
    dest = os.path.join(folder, fname)
    if os.path.exists(dest) and os.path.getsize(dest) > 1024:
        with STATE_LOCK:
            task.done += 1
        return True
    for attempt in range(3):
        if task.stop:
            return False
        try:
            data = winhttp_get(url, referer, timeout=40)
            if len(data) < 1500:
                raise ValueError("返回内容过小，可能不是图片")
            with open(dest, "wb") as f:
                f.write(data)
            with STATE_LOCK:
                task.done += 1
                task.current = fname
            return True
        except Exception as e:
            if attempt == 2:
                with STATE_LOCK:
                    task.failed += 1
                    task.current = fname + " (失败)"
                task.add_log("\u2717 失败 %s: %s" % (fname, e))
    return False


def run_task(params):
    global task
    t = Task()
    t.running = True
    t.folder = params.get("folder", "./4kdesk_images")
    t.thread_count = max(1, min(32, int(params.get("threads", 8))))
    task = t

    start_url = params.get("url", "").strip()
    pages = max(1, int(params.get("pages", 1)))
    fast_mode = bool(params.get("fast", False))

    os.makedirs(t.folder, exist_ok=True)
    t.add_log("保存目录: " + os.path.abspath(t.folder))
    t.add_log("起始页: " + start_url)
    t.add_log("模式: " + ("快速(列表图)" if fast_mode else "原图(访问详情页)") +
              " | 页数: %d | 线程: %d" % (pages, t.thread_count))

    if not start_url:
        t.add_log("错误：未提供起始 URL")
        t.running = False
        return

    image_urls = []
    seen_img = set()
    seen_page = set()
    cur_url = start_url
    collected_pages = 0

    try:
        while cur_url and collected_pages < pages and not t.stop:
            if cur_url in seen_page:
                break
            seen_page.add(cur_url)
            collected_pages += 1
            t.add_log("抓取列表页 [%d/%d]: %s" % (collected_pages, pages, cur_url))
            html = fetch_text(cur_url, cur_url)
            if fast_mode:
                for u in parse_listing_images(html):
                    if u not in seen_img:
                        seen_img.add(u)
                        image_urls.append(u)
            else:
                detail_urls, _ = parse_listing(html, cur_url)
                t.add_log("  发现 %d 个详情页" % len(detail_urls))
                for du in detail_urls:
                    if t.stop:
                        break
                    try:
                        dhtml = fetch_text(du, cur_url)
                        img = parse_detail_image(dhtml)
                        if img and img not in seen_img:
                            seen_img.add(img)
                            image_urls.append(img)
                    except Exception as e:
                        t.add_log("  \u2717 详情页失败 %s: %s" % (du, e))
            if collected_pages < pages:
                _, nxt = parse_listing(html, cur_url)
                cur_url = nxt
            else:
                cur_url = None
    except Exception as e:
        t.add_log("抓取过程出错: %s" % e)

    t.total = len(image_urls)
    t.add_log("共找到 %d 张图片，开始下载..." % t.total)

    # 并发下载（自带线程池，避免引入 multiprocessing）
    q = Queue()
    for u in image_urls:
        q.put(u)
    SENT = object()  # 哨兵：每个工作线程取到一个即退出
    for _ in range(t.thread_count):
        q.put(SENT)

    def worker():
        while True:
            if t.stop:
                break
            try:
                item = q.get(timeout=0.5)
            except Empty:
                continue
            if item is SENT:
                break
            try:
                ref = start_url if fast_mode else item
                download_one(item, t.folder, ref, t)
            except Exception:
                pass
            finally:
                try:
                    q.task_done()
                except Exception:
                    pass

    threads = [threading.Thread(target=worker, daemon=True)
               for _ in range(t.thread_count)]
    for th in threads:
        th.start()
    while any(th.is_alive() for th in threads) and not t.stop:
        time.sleep(0.2)

    t.running = False
    if t.stop:
        t.add_log("已停止。完成 %d / %d，失败 %d" % (t.done, t.total, t.failed))
    else:
        t.add_log("全部完成！成功 %d，失败 %d" % (t.done, t.failed))
    t.stop = False


# ---------------------------------------------------------------------------
# 极简 raw-socket HTTP 服务（替代 http.server，避免引入 ssl/http/email）
# ---------------------------------------------------------------------------
HTML_PAGE = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>4K图片批量下载器</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family: "Microsoft YaHei","PingFang SC",system-ui,sans-serif;
         background:#0f1220; color:#e6e9f2; }
  .wrap { max-width:860px; margin:0 auto; padding:24px 18px 40px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .sub { color:#8b93b0; font-size:13px; margin-bottom:18px; }
  .card { background:#181c2e; border:1px solid #2a3050; border-radius:12px; padding:16px 18px; margin-bottom:16px; }
  label { display:block; font-size:13px; color:#aab2d5; margin:10px 0 5px; }
  input[type=text], input[type=number] { width:100%; padding:9px 10px; border-radius:8px;
         border:1px solid #2a3050; background:#0f1220; color:#e6e9f2; font-size:14px; }
  .row { display:flex; gap:12px; }
  .row > div { flex:1; }
  .modes { display:flex; gap:18px; margin-top:6px; font-size:14px; }
  .modes label { display:inline; margin:0; color:#e6e9f2; cursor:pointer; }
  .btns { display:flex; gap:12px; margin-top:16px; }
  button { flex:1; padding:11px; border:none; border-radius:8px; font-size:15px; cursor:pointer; font-weight:600; }
  .start { background:#3b82f6; color:#fff; }
  .start:hover { background:#2f6fd6; }
  .stop { background:#ef4444; color:#fff; }
  .stop:hover { background:#d63b3b; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .progress { height:14px; background:#0f1220; border-radius:8px; overflow:hidden; border:1px solid #2a3050; }
  .bar { height:100%; width:0; background:linear-gradient(90deg,#3b82f6,#22d3ee); transition:width .3s; }
  .stats { display:flex; gap:18px; font-size:13px; color:#aab2d5; margin-top:10px; }
  .stats b { color:#e6e9f2; }
  #log { background:#0a0c16; border:1px solid #2a3050; border-radius:8px; height:240px; overflow:auto;
         padding:10px; font-family:Consolas,Menlo,monospace; font-size:12.5px; line-height:1.55; color:#9fb3ff; white-space:pre-wrap; }
  .tip { font-size:12px; color:#6b739a; margin-top:6px; }
  .current { color:#22d3ee; }
</style>
</head>
<body>
<div class="wrap">
  <h1>4K 图片批量下载器</h1>
  <div class="sub">目标站点：4kdesk.com · 自动翻页 · 多线程下载原图</div>

  <div class="card">
    <label>起始列表页 URL（例如某分类的分页地址）</label>
    <input type="text" id="url" value="https://www.4kdesk.com/4Kmeinv/index_2.html">

    <div class="row">
      <div>
        <label>下载页数（从起始页向后翻页）</label>
        <input type="number" id="pages" value="3" min="1" max="200">
      </div>
      <div>
        <label>并发线程数</label>
        <input type="number" id="threads" value="8" min="1" max="32">
      </div>
    </div>

    <label>保存文件夹（绝对路径，例如 D:\Pictures\4k）</label>
    <input type="text" id="folder" value="__FOLDER__">

    <label>下载模式</label>
    <div class="modes">
      <div><input type="radio" name="mode" id="mOrig" value="orig" checked>
           <label for="mOrig">原图模式（访问详情页，画质更高）</label></div>
      <div><input type="radio" name="mode" id="mFast" value="fast">
           <label for="mFast">快速模式（仅列表图，更快）</label></div>
    </div>
    <div class="tip">提示：原图模式下“下载原图”按钮需登录，本工具抓取详情页展示的高清大图。</div>

    <div class="btns">
      <button class="start" id="btnStart">开始下载</button>
      <button class="stop" id="btnStop" disabled>停止</button>
    </div>
  </div>

  <div class="card">
    <div class="progress"><div class="bar" id="bar"></div></div>
    <div class="stats">
      <span>总数 <b id="stotal">0</b></span>
      <span>已完成 <b id="sdone">0</b></span>
      <span>失败 <b id="sfailed">0</b></span>
      <span class="current" id="scurrent"></span>
    </div>
  </div>

  <div class="card">
    <label>运行日志</label>
    <div id="log"></div>
  </div>
</div>

<script>
const $ = id => document.getElementById(id);

function start() {
  const payload = {
    url: $("url").value.trim(),
    pages: parseInt($("pages").value) || 1,
    threads: parseInt($("threads").value) || 8,
    folder: $("folder").value.trim(),
    fast: $("mFast").checked
  };
  fetch("/api/start", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  }).then(()=>{
    $("btnStart").disabled = true;
    $("btnStop").disabled = false;
    poll();
  }).catch(e=>alert("启动失败: "+e));
}

function stop() {
  fetch("/api/stop", {method:"POST"}).then(()=>{ $("btnStop").disabled = true; });
}

function poll() {
  fetch("/api/status").then(r=>r.json()).then(s=>{
    $("stotal").textContent = s.total;
    $("sdone").textContent = s.done;
    $("sfailed").textContent = s.failed;
    $("scurrent").textContent = s.current ? ("当前: "+s.current) : "";
    const pct = s.total ? Math.round(s.done/s.total*100) : 0;
    $("bar").style.width = pct + "%";
    $("log").textContent = s.log.join("\n");
    $("log").scrollTop = $("log").scrollHeight;
    if (!s.running && s.total>0) {
      $("btnStart").disabled = false;
      $("btnStop").disabled = true;
    }
  }).catch(()=>{});
  setTimeout(poll, 1000);
}

$("btnStart").onclick = start;
$("btnStop").onclick = stop;
poll();
</script>
</body>
</html>"""


def app_handler(method, path, headers, body):
    global task, server_ref
    path = path.split("?", 1)[0]
    if method == "GET" and path in ("/", "/index.html"):
        default_folder = os.path.join(
            os.path.expanduser("~"), "Pictures", "4kdesk_images")
        page = HTML_PAGE.replace("__FOLDER__", default_folder.replace("\\", "/"))
        return 200, "text/html; charset=utf-8", page
    if method == "GET" and path == "/api/status":
        snap = task.snapshot() if task else {
            "total": 0, "done": 0, "failed": 0, "running": False,
            "stop": False, "current": "", "log": [], "folder": ""}
        return 200, "application/json; charset=utf-8", json.dumps(snap, ensure_ascii=False)
    if path == "/api/exit":
        return 200, "application/json; charset=utf-8", json.dumps({"ok": True})
        # 实际退出在调用方处理（见下方）
    if method == "POST" and path == "/api/start":
        try:
            data = json.loads(body.decode("utf-8")) if body else {}
        except Exception:
            data = {}
        threading.Thread(target=run_task, args=(data,), daemon=True).start()
        return 200, "application/json; charset=utf-8", json.dumps({"ok": True})
    if method == "POST" and path == "/api/stop":
        if task:
            task.stop = True
        return 200, "application/json; charset=utf-8", json.dumps({"ok": True})
    return 404, "application/json; charset=utf-8", json.dumps({"error": "not found"})


class MiniServer:
    def __init__(self, handler):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.port = self.sock.getsockname()[1]
        self.sock.listen(8)
        self.handler = handler
        self._run = True

    def serve_forever(self):
        while self._run:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                break
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn):
        try:
            conn.settimeout(5)
            req = b""
            while b"\r\n\r\n" not in req and len(req) < 65536:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                req += chunk
            header_part, _, rest = req.partition(b"\r\n\r\n")
            lines = header_part.split(b"\r\n")
            parts = lines[0].decode("utf-8", "ignore").split(" ")
            method = parts[0] if parts else "GET"
            path = parts[1] if len(parts) > 1 else "/"
            hdict = {}
            for ln in lines[1:]:
                if b":" in ln:
                    k, v = ln.split(b":" 1)
                    hdict[k.decode().strip().lower()] = v.decode().strip()
            body = rest
            try:
                cl = int(hdict.get("content-length", 0) or 0)
            except Exception:
                cl = 0
            while len(body) < cl:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                body += chunk
            if path.split("?", 1)[0] == "/api/exit":
                try:
                    conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                except Exception:
                    pass
                shutdown_server()
                return
            status, ctype, resp = self.handler(method, path, hdict, body)
            if isinstance(resp, str):
                resp = resp.encode("utf-8")
            head = ("HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %d\r\n"
                    "Access-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
                    % (status, ctype, len(resp)))
            conn.sendall(head.encode("utf-8") + resp)
        except Exception:
            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def shutdown(self):
        self._run = False
        try:
            self.sock.close()
        except Exception:
            pass


def shutdown_server():
    try:
        if server_ref:
            server_ref.shutdown()
    except Exception:
        pass
    try:
        os._exit(0)
    except Exception:
        pass


def find_free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def main():
    global server_ref
    server = MiniServer(app_handler)
    server_ref = server
    port = server.port
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/" % port
    try:
        webbrowser.open(url)
    except Exception:
        pass

    def box():
        try:
            if ctypes:
                ctypes.windll.user32.MessageBoxW(
                    0,
                    "4K 图片批量下载器已启动\n\n请在浏览器中操作：\n" + url +
                    "\n\n点击“确定”可退出程序。",
                    "4K图片下载器", 0)
        except Exception:
            pass
        shutdown_server()

    threading.Thread(target=box, daemon=True).start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    shutdown_server()


# ---------------------------------------------------------------------------
# 自检测试（冻结后可无界面验证）
# ---------------------------------------------------------------------------
def selftest():
    logpath = os.path.join(os.path.dirname(os.path.abspath(sys.executable)), "selftest.log")
    sys.stdout = open(logpath, "w", encoding="utf-8", errors="ignore")
    sys.stderr = sys.stdout
    try:
        _selftest_impl()
        print("\n全部自检通过 \u2705")
    except Exception:
        import traceback
        traceback.print_exc()
    finally:
        sys.stdout.flush()
        sys.stdout.close()


def _selftest_impl():
    print("== WinHTTP 测试 ==")
    html = fetch_text("https://www.4kdesk.com/4Kmeinv/index_2.html")
    assert "4Kmeinv" in html, "列表页抓取失败"
    detail_urls, nxt = parse_listing(html, "https://www.4kdesk.com/4Kmeinv/index_2.html")
    assert detail_urls, "未解析到详情页"
    assert nxt and "index_3" in nxt, "未解析到下一页: %r" % nxt
    print("列表解析 OK，详情数=%d, 下一页=%s" % (len(detail_urls), nxt))

    dhtml = fetch_text(detail_urls[0])
    img = parse_detail_image(dhtml)
    assert img and "53326" in img, "详情页图片解析失败: %r" % img
    print("详情图 OK:", img)

    folder = os.path.join(os.path.dirname(os.path.abspath(__file__)), "selftest_out")
    os.makedirs(folder, exist_ok=True)
    ok = download_one(img, folder, detail_urls[0], type("T", (), {"stop": False, "done": 0, "failed": 0, "current": ""})())
    # 上面的 hack 不会累计，直接调用内部逻辑
    import threading as _t
    _task = Task()
    ok = download_one(img, folder, detail_urls[0], _task)
    assert ok and os.path.getsize(os.path.join(folder, os.path.basename(img))) > 1000
    print("下载 OK, 大小=", os.path.getsize(os.path.join(folder, os.path.basename(img))))

    print("== 本地 HTTP 服务测试 ==")
    srv = MiniServer(app_handler)
    global server_ref
    server_ref = srv
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    import socket as _s
    def get(path):
        c = _s.socket(_s.AF_INET, _s.SOCK_STREAM)
        c.connect(("127.0.0.1", srv.port))
        c.sendall(("GET %s HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n" % path).encode())
        c.settimeout(3)
        data = b""
        try:
            while True:
                b = c.recv(4096)
                if not b:
                    break
                data += b
        except Exception:
            pass
        c.close()
        return data
    resp = get("/")
    assert b"4K" in resp, "主页返回异常"
    resp2 = get("/api/status")
    assert b"total" in resp2, "状态接口异常"
    print("HTTP 服务 OK (端口 %d)" % srv.port)
    srv.shutdown()
    print("\n全部自检通过 \u2705")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
