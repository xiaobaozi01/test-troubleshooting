from fastapi import APIRouter
from stock_service import reserve

router = APIRouter(prefix="/internal/stock")

@router.post("/reserve")
def reserve_endpoint(sku: str, quantity: int):
    return reserve(sku, quantity)
