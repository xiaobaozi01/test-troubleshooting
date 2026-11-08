"""模拟库存服务；源代码版本未与运行容器核对。"""
import os

def require_namespace():
    if not os.environ.get("CACHE_NAMESPACE", "").strip():
        raise RuntimeError("STOCK_CACHE_CONFIG_MISSING: CACHE_NAMESPACE is empty")
    return os.environ["CACHE_NAMESPACE"]

def reserve(sku, quantity):
    namespace = require_namespace()
    return {"key": f"{namespace}:{sku}", "quantity": quantity}
