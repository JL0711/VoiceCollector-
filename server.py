#!/usr/bin/env python3
"""VoiceCollector 本地启动器（网页版）
在 127.0.0.1 上起一个小服务器并打开浏览器。
麦克风只在 https 或 localhost 下可用，所以必须这样跑，不能直接双击 index.html。"""
import http.server, socketserver, webbrowser, os, sys, threading, subprocess, platform, json, urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
PORTS = [int(os.environ["VC_PORT"])] if os.environ.get("VC_PORT") else [8787, 8788, 8799, 8080, 9123]

class H(http.server.SimpleHTTPRequestHandler):
    # HTTP/1.1 + keep-alive：浏览器加载 AI 模型时会并行拉好几个大文件
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def end_headers(self):
        # 模型权重要允许浏览器缓存，其余的不缓存（方便更新）
        if "/models/" in self.path or "/vendor/" in self.path:
            self.send_header("Cache-Control", "public, max-age=604800")
        else:
            self.send_header("Cache-Control", "no-store")
        # 开启 cross-origin isolation，ONNX 才能用多线程（快很多）
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()

    def log_message(self, *a):
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """必须是多线程的 —— 单线程服务器在浏览器并行拉模型文件时会直接卡死。"""
    daemon_threads = True
    allow_reuse_address = True

def open_browser(url):
    if os.environ.get("VC_NO_BROWSER") == "1":   # 自动化测试时别在屏幕上弹浏览器
        return
    if platform.system() == "Darwin":
        for app in ("Google Chrome", "Microsoft Edge", "Brave Browser"):
            try:
                subprocess.run(["open", "-a", app, url], check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return
            except Exception:
                continue
    webbrowser.open(url)

def already_running(port):
    """这个端口上是不是已经跑着我们自己（上一次双击开的）。"""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/version.json", timeout=1.5) as r:
            return "version" in json.loads(r.read().decode("utf-8"))
    except Exception:
        return False

def main():
    if not os.path.isdir(ROOT):
        print("找不到 web 文件夹：", ROOT); sys.exit(1)
    # ⚠️ 浏览器的数据（上过的课、老师、设置）是按「网址」存的，端口也算网址的一部分。
    #    换一个端口 = 换一个网站 = 看上去所有东西都没了。所以：
    #    · 已经开着一个了（比如双击了两次）→ 直接打开那一个，绝不另起一个新端口
    #    · 8787 被别的程序占了 → 才换端口，并且把后果说清楚
    if already_running(PORTS[0]):
        url = f"http://localhost:{PORTS[0]}/index.html"
        print("VoiceCollector 已经在运行了，直接打开它：", url)
        open_browser(url)
        return
    for port in PORTS:
        try:
            httpd = Server(("127.0.0.1", port), H)
        except OSError:
            continue
        url = f"http://localhost:{port}/index.html"
        print("=" * 58)
        print("  VoiceCollector 课堂助手（网页版）已启动")
        print("  浏览器地址： " + url)
        print("  关掉这个黑窗口 = 关掉程序（先在网页里结束录制！）")
        if port != PORTS[0]:
            print("")
            print(f"  ⚠️ 平时用的 {PORTS[0]} 端口被别的程序占用了，这次临时用 {port}。")
            print(f"     浏览器按网址存数据，所以这次看不到以前的课（它们没丢）。")
            print(f"     关掉占用 {PORTS[0]} 的程序、再重新打开，就都回来了。")
        print("=" * 58)
        threading.Timer(0.8, open_browser, args=(url,)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已退出。")
        return
    print("所有端口都被占用了：", PORTS)

if __name__ == "__main__":
    main()
