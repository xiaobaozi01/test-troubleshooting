package demo;
import org.springframework.beans.factory.annotation.Value;

class PartnerClient {
    @Value("${partner.api.base-url}")
    private String baseUrl;

    // GET /api/partner/status 调用三方 GET {baseUrl}/v1/status。
    public String status() { return baseUrl + "/v1/status"; }
}
