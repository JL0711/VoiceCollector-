#!/usr/bin/env python3
"""VoiceCollector 本地启动器 —— 晗晗专属
在 127.0.0.1 上起一个小服务器并打开浏览器。
麦克风只在 https 或 localhost 下可用，所以必须这样跑，不能直接双击 index.html。"""
import http.server, socketserver, webbrowser, os, sys, threading, subprocess, platform

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
PORTS = [8787, 8788, 8799, 8080, 9123]

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
    if platform.system() == "Darwin":
        for app in ("Google Chrome", "Microsoft Edge", "Brave Browser"):
            try:
                subprocess.run(["open", "-a", app, url], check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return
            except Exception:
                continue
    webbrowser.open(url)

def main():
    if not os.path.isdir(ROOT):
        print("找不到 web 文件夹：", ROOT); sys.exit(1)
    for port in PORTS:
        try:
            httpd = Server(("127.0.0.1", port), H)
        except OSError:
            continue
        url = f"http://localhost:{port}/index.html"
        print("=" * 58)
        print("  VoiceCollector · 晗晗专属课堂助手 已启动")
        print("  浏览器地址： " + url)
        print("  关掉这个黑窗口 = 关掉程序（先在网页里结束录制！）")
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
