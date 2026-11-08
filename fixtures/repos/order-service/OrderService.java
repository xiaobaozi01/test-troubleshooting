// 模拟代码，用于验证检索和跨服务排障；没有确认运行版本。
package demo;

class OrderService {
    private final StockClient stock;

    OrderService(StockClient stock) { this.stock = stock; }

    // POST /api/orders
    public Order createOrder(String sku, int quantity) {
        // 下游库存预占失败时向调用方返回 ORDER_CREATE_FAILED。
        stock.reserve(sku, quantity);
        return new Order(sku, quantity);
    }
}
