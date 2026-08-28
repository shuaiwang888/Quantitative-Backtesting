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
    HOST=0.0.0.0 \
    PORT=7860

# 把 __pycache__ 写到 /tmp（HF 容器根文件系统是只读层之上的可写层，
# 写业务目录会污染镜像 diff；HF 多次重启后 /tmp 会自动清空）
WORKDIR /app

# 依赖单独一层，最大化镜像层缓存命中
COPY requirements.txt ./
RUN pip install -r requirements.txt

# 业务代码
COPY quant/ ./quant/
COPY static/ ./static/
COPY app.py ./
COPY app_hf.py ./

# 容器暴露 7860，HOST=0.0.0.0 由上方 ENV 显式设置
EXPOSE 7860

# 健康检查：不依赖问财 / MySQL 的轻量端点
# 端口用 ${PORT:-7860} 兼容：HF Space 默认 7860，Render 自动注入 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD sh -c "python -c \"import urllib.request,sys; \
sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:${PORT:-7860}/api/health', timeout=3).status == 200 else 1)\""

# Docker / Render 使用零 Web 框架依赖的 stdlib 服务。
# HF Gradio SDK Space 仍由 Space frontmatter 直接启动 app_hf.py。
CMD ["python", "app.py"]
