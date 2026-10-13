import flatRevenuePath from "../assets/flat-icons/revenue-new.png";
import flatTotalOrdersPath from "../assets/flat-icons/total-orders-new.png";
import flatGateCountPath from "../assets/flat-icons/gate-count-icon.png";
import flatHeadcountPath from "../assets/flat-icons/headcount-new.png";
import flatAvgOrderPath from "../assets/flat-icons/avg-order-new.png";
import flatTicketPath from "../assets/flat-icons/ticket-new.png";
import flatFnbPath from "../assets/flat-icons/fnb-new.png";
import flatExtrasPath from "../assets/flat-icons/extras-new.png";
import flatNannyPath from "../assets/flat-icons/nanny-new.png";
import flatPerfGraphPath from "../assets/flat-icons/perf-graph-new.png";
import flatPaymentPath from "../assets/flat-icons/payment-new.png";
import flatTopProductsPath from "../assets/flat-icons/top-products-new.png";
import flatDailyRevenuePath from "../assets/flat-icons/daily-revenue-new.png";
import flatMerchPath from "../assets/flat-icons/merchandise-new.png";
import flatEventsPath from "../assets/flat-icons/events-new.png";
import flatAvgStayPath from "../assets/flat-icons/avg-stay-new.png";
import flatCustomerTypesPath from "../assets/flat-icons/customer-types-new.png";
import flatAppIconPath from "../assets/flat-icons/app-icon-new.png";
import otoLoadingPath from "../assets/oto-icons/oto-loading.png";
import otoLivePath from "../assets/oto-icons/oto-live.png";
import otoLogoFullPath from "../assets/oto-icons/oto-logo-full.png";

function otoIcon(src: string, alt: string) {
  return function OtoIconComponent({ className }: { className?: string }) {
    return (
      <img
        src={src}
        alt={alt}
        className={className}
        style={{ objectFit: "contain" }}
        draggable={false}
      />
    );
  };
}

export const OtoCoin = otoIcon(flatDailyRevenuePath, "Daily Revenue");
export const OtoCurrency = otoIcon(flatRevenuePath, "Revenue");
export const OtoPlayCoin = otoIcon(flatAvgOrderPath, "Avg Order Value");
export const OtoRevenue = otoIcon(flatRevenuePath, "Revenue");
export const OtoTotalOrders = otoIcon(flatTotalOrdersPath, "Total Orders");
export const OtoHeadcount = otoIcon(flatHeadcountPath, "Headcount");
export const OtoGateCount = otoIcon(flatGateCountPath, "Gate Count");
export const OtoAvgOrder = otoIcon(flatAvgOrderPath, "Avg Order Value");
export const OtoTicket = otoIcon(flatTicketPath, "Tickets & Packages");
export const OtoFnb = otoIcon(flatFnbPath, "Food & Beverage");
export const OtoExtras = otoIcon(flatExtrasPath, "Extras & Add-ons");
export const OtoNanny = otoIcon(flatNannyPath, "Nanny & Drop-off");
export const OtoPerfGraph = otoIcon(flatPerfGraphPath, "Performance Graph");
export const OtoPayment = otoIcon(flatPaymentPath, "Payment Methods");
export const OtoTopProducts = otoIcon(flatTopProductsPath, "Top Products");
export const OtoMerch = otoIcon(flatMerchPath, "Merchandise");
export const OtoEvents = otoIcon(flatEventsPath, "Events & Birthdays");
export const OtoAvgStay = otoIcon(flatAvgStayPath, "Average Stay");
export const OtoVipTicket = otoIcon(flatCustomerTypesPath, "Customer Types");
export const OtoAppIcon = otoIcon(flatAppIconPath, "OTO");
export const OtoLive = otoIcon(otoLivePath, "Live");
export const OtoLogoFull = otoIcon(otoLogoFullPath, "OTO Radar");

export const OtoGiftBag = OtoTotalOrders;
export const OtoRainbowPass = OtoTicket;
export const OtoClayShake = OtoFnb;
export const OtoNannyBadge = OtoNanny;
export const OtoCelebration = OtoEvents;
export const OtoLittle = OtoMerch;

export const otoAppIconPath = flatAppIconPath;
export {
  otoLoadingPath,
  otoLogoFullPath,
};
