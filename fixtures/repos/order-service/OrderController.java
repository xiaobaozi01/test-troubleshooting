package demo;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
class OrderController {
    private final OrderService service;
    OrderController(OrderService service) { this.service = service; }

    @PostMapping("/orders")
    public Object create(String sku, int quantity) {
        return service.createOrder(sku, quantity);
    }

    @GetMapping("/partner/status")
    public String partnerStatus() { return "模拟三方调用；逻辑见 PartnerClient.java"; }
}
