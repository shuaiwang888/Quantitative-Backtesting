# syntax=docker/dockerfile:1.6
# ───────────────────────────────────────────────────────────────────
# A股量化回测平台后端 → Hugging Face Spaces (Docker SDK)
# 镜像内只跑后端 + Python stdlib http.server；前端由 GitHub Pages 提供。
# ───────────────────────────────────────────────────────────────────

FROM python:3.10-slim

# HF Space 默认探测端口 = 7860；CI 矩阵下限 = 3.10；slim 已含 pip
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPYCACHEPREFIX=/tmp/pycache \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=7860

# 把 __pycache__ 写到 /tmp（HF 容器根文件系统是只读层之上的可写层，
# 写业务目录会污染镜像 diff；HF 多次重启后 /tmp 会自动清空）
WORKDIR /app

# 依赖单独一层，最大化镜像层缓存命中
COPY requirements.txt ./
RUN pip install -r requirements.txt

# 业务代码
COPY quant/ ./quant/
COPY app.py ./
COPY app_hf.py ./

# HF 硬性要求：EXPOSE 7860 + 0.0.0.0 监听（由 Settings.host 默认值保证）
EXPOSE 7860

# 健康检查：/api/strategies 是真实业务端点（最稳）
# 端口用 ${PORT:-7860} 兼容：HF Space 默认 7860，Render 自动注入 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD sh -c "python -c \"import urllib.request,sys; \
sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:${PORT:-7860}/api/strategies', timeout=3).status == 200 else 1)\""

# HF Space 走 app_hf.py（Gradio Blocks，CPU 运行）。
# 本地仍走 app.py（stdlib http.server，零依赖）。
CMD ["python", "app_hf.py"]
