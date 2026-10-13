import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import DeliverySettingsPage from './delivery/DeliverySettingsPage';
import DispatchPage from './delivery/DispatchPage';
import DriverCutsPage from './delivery/DriverCutsPage';
import DriverApp from './driver/DriverApp';
import { usePwaManifest } from './lib/pwa';
import CustomersPage from './loyalty/CustomersPage';
import CountPage from './inventory/CountPage';
import CountsPage from './inventory/CountsPage';
import InventoryLayout from './inventory/InventoryLayout';
import ProductsPage from './inventory/ProductsPage';
import PurchasesPage from './inventory/PurchasesPage';
import RecipesPage from './inventory/RecipesPage';
import StockPage from './inventory/StockPage';
import SuppliersPage from './inventory/SuppliersPage';
import UsagePage from './inventory/UsagePage';
import DownloadsPage from './home/DownloadsPage';
import FleetPage from './platform/FleetPage';
import InvoicesPage from './platform/InvoicesPage';
import ModulesCatalogPage from './platform/ModulesCatalogPage';
import PlatformLayout from './platform/PlatformLayout';
import CashPage from './pos/CashPage';
import KitchenPage from './pos/KitchenPage';
import MenuAdminPage from './pos/MenuAdminPage';
import PosGate from './pos/PosGate';
import PosSettingsPage from './pos/PosSettingsPage';
import PromotionsPage from './pos/PromotionsPage';
import SelfOrderKiosk from './pos/SelfOrderKiosk';
import ReportsPage from './pos/ReportsPage';
import RegisterPage from './pos/RegisterPage';
import TablesAdminPage from './pos/TablesAdminPage';
import PartnerHomePage from './partner/PartnerHomePage';
import PartnerHoursPage from './partner/PartnerHoursPage';
import PartnerLayout from './partner/PartnerLayout';
import PlatformLogin from './platform/PlatformLogin';
import PlatformSettingsPage from './platform/PlatformSettingsPage';
import RestaurantDetailPage from './platform/RestaurantDetailPage';
import RestaurantsPage from './platform/RestaurantsPage';
import AdminLayout from './restaurant/AdminLayout';
import BranchesPage from './restaurant/BranchesPage';
import DashboardPage from './restaurant/DashboardPage';
import FeedbackPage from './restaurant/FeedbackPage';
import WhatsAppPage from './restaurant/WhatsAppPage';
import RestaurantLogin from './restaurant/RestaurantLogin';
import { StaffForgotPage, StaffResetPage } from './restaurant/StaffPasswordPages';
import SubscriptionPage from './restaurant/SubscriptionPage';
import OnlineSettingsPage from './restaurant/OnlineSettingsPage';
import UsersPage from './restaurant/UsersPage';
import WebsitePage from './restaurant/WebsitePage';
import AnnouncementsPage from './rh/AnnouncementsPage';
import ChatPage from './chat/ChatPage';
import SavingsDetailPage from './savings/SavingsDetailPage';
import SavingsPage from './savings/SavingsPage';
import AttendancePage from './rh/AttendancePage';
import ChecklistsPage from './rh/ChecklistsPage';
import EmployeesPage from './rh/EmployeesPage';
import IncidentsPage from './rh/IncidentsPage';
import KioskPage from './rh/KioskPage';
import ModuleGate from './rh/ModuleGate';
import MyPayrollPage from './rh/MyPayrollPage';
import { AguinaldoPage, ClaimsPage } from './rh/PayrollExtras';
import PayrollPage from './rh/PayrollPage';
import PayrollPeriodPage from './rh/PayrollPeriodPage';
import RecognitionPage from './rh/RecognitionPage';
import RhLayout from './rh/RhLayout';
import RhSettingsPage from './rh/RhSettingsPage';
import ShiftsPage from './rh/ShiftsPage';
import WallPage from './rh/WallPage';
import {
  AccountPage, ForgotPasswordPage, LoginPage, OrdersPage, RegisterPage as CustomerRegisterPage, ResetPasswordPage,
} from './site/AccountPages';
import CheckoutPage from './site/CheckoutPage';
import EventsPage from './events/EventsPage';
import EventDetailPage from './events/EventDetailPage';
import EventPublicPage from './site/EventPublicPage';
import OrderPage from './site/OrderPage';
import PaymentResultPage from './site/PaymentResultPage';
import DeliveryLanding from './marketplace/DeliveryLanding';
import DriverSignupPage from './marketplace/DriverSignupPage';
import ListingPage from './marketplace/ListingPage';
import NayoOrdersBoard from './marketplace/NayoOrdersBoard';
import DeliveryRestaurantPage from './marketplace/RestaurantPage';
import RestaurantSignupPage from './marketplace/RestaurantSignupPage';
import DeliveryTrackPage from './marketplace/TrackPage';
import { onNayoHost } from './marketplace/nayoUrl';
import NayoResetPage from './marketplace/NayoResetPage';
import NayoPartnersPage from './marketplace/NayoPartnersPage';
import MarketplacePage from './platform/MarketplacePage';
import PublicSite from './site/PublicSite';
import SiteLayout from './site/SiteLayout';
import TrackOrderPage from './site/TrackOrderPage';

/**
 * elnayo.com: solo Nayo, en la raiz. Las ligas viejas /nayo/... (y /delivery/...)
 * se redirigen quitando el prefijo; la app del repartidor sigue en /repartidor.
 */
function NayoSite() {
  return (
    <Routes>
      <Route path="/" element={<DeliveryLanding />} />
      <Route path="/socios" element={<NayoPartnersPage />} />
      <Route path="/restaurantes" element={<RestaurantSignupPage />} />
      <Route path="/repartidores" element={<DriverSignupPage />} />
      <Route path="/r/:branchId" element={<DeliveryRestaurantPage />} />
      <Route path="/pedido/:token" element={<DeliveryTrackPage />} />
      <Route path="/restablecer" element={<NayoResetPage />} />
      <Route path="/repartidor" element={<DriverApp />} />
      <Route path="/nayo/*" element={<StripPrefix prefix="/nayo" />} />
      <Route path="/delivery/*" element={<StripPrefix prefix="/delivery" />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function StripPrefix({ prefix }: { prefix: string }) {
  const { pathname, search } = useLocation();
  return <Navigate to={`${pathname.slice(prefix.length) || '/'}${search}`} replace />;
}

/** Manifest de la app de Nayo que se esta viendo (lib/pwa.ts). */
function PwaManifest() {
  usePwaManifest(useLocation().pathname);
  return null;
}

export default function App() {
  if (onNayoHost()) return <BrowserRouter><PwaManifest /><NayoSite /></BrowserRouter>;
  return (
    <BrowserRouter>
      <PwaManifest />
      <Routes>
        {/* Sitio publico y portal de clientes del restaurante (por dominio) */}
        <Route element={<SiteLayout />}>
          <Route path="/" element={<PublicSite />} />
          <Route path="/pedir" element={<OrderPage />} />
          <Route path="/pedir/checkout" element={<CheckoutPage />} />
          <Route path="/pedido/:token" element={<TrackOrderPage />} />
          <Route path="/pago/resultado" element={<PaymentResultPage />} />
          <Route path="/evento/:slug" element={<EventPublicPage />} />
          <Route path="/cuenta" element={<AccountPage />} />
          <Route path="/cuenta/entrar" element={<LoginPage />} />
          <Route path="/cuenta/registro" element={<CustomerRegisterPage />} />
          <Route path="/cuenta/olvide" element={<ForgotPasswordPage />} />
          <Route path="/cuenta/restablecer" element={<ResetPasswordPage />} />
          <Route path="/cuenta/pedidos" element={<OrdersPage />} />
        </Route>

        {/* Instaladores de NeuronPOS y Neuron KDS */}
        <Route path="/descargas" element={<DownloadsPage />} />

        {/* Nayo: registro gratis de restaurantes y repartidores. /nayo es la
            ruta canonica; /delivery sigue sirviendo para los enlaces viejos. */}
        {['/nayo', '/delivery'].flatMap((base) => [
          <Route key={base} path={base} element={<DeliveryLanding />} />,
          <Route key={`${base}/socios`} path={`${base}/socios`} element={<NayoPartnersPage />} />,
          <Route key={`${base}/restaurantes`} path={`${base}/restaurantes`} element={<RestaurantSignupPage />} />,
          <Route key={`${base}/repartidores`} path={`${base}/repartidores`} element={<DriverSignupPage />} />,
          <Route key={`${base}/r`} path={`${base}/r/:branchId`} element={<DeliveryRestaurantPage />} />,
          <Route key={`${base}/pedido`} path={`${base}/pedido/:token`} element={<DeliveryTrackPage />} />,
          <Route key={`${base}/restablecer`} path={`${base}/restablecer`} element={<NayoResetPage />} />,
        ])}
        {/* Kiosko de autoservicio (pantalla completa, sesion de caja) */}
        <Route path="/autoservicio" element={<SelfOrderKiosk />} />

        {/* App del repartidor (propio del restaurante o de la flota) */}
        <Route path="/repartidor" element={<DriverApp />} />

        {/* Panel NeuronPOS (dueno de la plataforma) */}
        <Route path="/panel/login" element={<PlatformLogin />} />
        <Route path="/panel" element={<PlatformLayout />}>
          <Route index element={<RestaurantsPage />} />
          <Route path="restaurantes/:id" element={<RestaurantDetailPage />} />
          <Route path="modulos" element={<ModulesCatalogPage />} />
          <Route path="cobros" element={<InvoicesPage />} />
          <Route path="flota" element={<FleetPage />} />
          <Route path="delivery" element={<MarketplacePage />} />
          <Route path="ajustes" element={<PlatformSettingsPage />} />
        </Route>

        {/* Nayo Partner: app instalable del restaurante (pantallas del panel del restaurante) */}
        <Route path="/partner/entrar" element={<RestaurantLogin next="/partner" />} />
        <Route path="/partner" element={<PartnerLayout />}>
          <Route index element={<PartnerHomePage />} />
          <Route path="pedidos" element={<NayoOrdersBoard exitTo="/partner" />} />
          <Route path="menu" element={<MenuAdminPage />} />
          <Route path="horario" element={<PartnerHoursPage />} />
          <Route path="ajustes" element={<ListingPage base="/partner" />} />
        </Route>

        {/* Administracion del restaurante */}
        <Route path="/admin/login" element={<RestaurantLogin />} />
        <Route path="/admin/olvide" element={<StaffForgotPage />} />
        <Route path="/admin/restablecer" element={<StaffResetPage />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="sucursales" element={<BranchesPage />} />
          <Route path="usuarios" element={<UsersPage />} />
          <Route path="sitio" element={<WebsitePage />} />
          <Route path="pedidos-en-linea" element={<OnlineSettingsPage />} />
          <Route path="suscripcion" element={<SubscriptionPage />} />
          {/* Punto de venta (modulo pos) */}
          <Route element={<PosGate />}>
            <Route path="pos" element={<RegisterPage />} />
            <Route path="cocina" element={<KitchenPage />} />
            <Route path="caja" element={<CashPage />} />
            <Route path="mesas" element={<TablesAdminPage />} />
            <Route path="pos/ajustes" element={<PosSettingsPage />} />
            <Route path="promociones" element={<PromotionsPage />} />
            <Route element={<ModuleGate code="reportes" name="Reportes de ventas" />}>
              <Route path="reportes" element={<ReportsPage />} />
            </Route>
          </Route>
          {/* Ventas por evento (modulo eventos) */}
          <Route element={<ModuleGate code="eventos" name="Eventos y preventas" />}>
            <Route path="eventos" element={<EventsPage />} />
            <Route path="eventos/:id" element={<EventDetailPage />} />
          </Route>
          {/* Menu: lo usa el POS y tambien un restaurante que solo esta en Nayo */}
          <Route element={<ModuleGate code={['pos', 'marketplace']} name="Menú" />}>
            <Route path="menu" element={<MenuAdminPage />} />
          </Route>
          {/* Nayo (modulo marketplace, sin costo) */}
          <Route element={<ModuleGate code="marketplace" name="Nayo" />}>
            <Route path="delivery" element={<ListingPage />} />
            <Route path="delivery/pedidos" element={<NayoOrdersBoard />} />
          </Route>
          {/* Clientes: modulos lealtad y monedero */}
          <Route element={<ModuleGate code={['lealtad', 'monedero']} name="Clientes y lealtad" />}>
            <Route path="clientes" element={<CustomersPage />} />
          </Route>
          {/* Inventario y compras (modulo inventario) */}
          <Route element={<ModuleGate code="inventario" name="Inventario y compras" />}>
            <Route path="inventario" element={<InventoryLayout />}>
              <Route index element={<StockPage />} />
              <Route path="conteos" element={<CountsPage />} />
              <Route path="conteos/:id" element={<CountPage />} />
              <Route path="compras" element={<PurchasesPage />} />
              <Route path="insumos" element={<ProductsPage />} />
              <Route path="recetas" element={<RecipesPage />} />
              <Route path="proveedores" element={<SuppliersPage />} />
              <Route path="consumo" element={<UsagePage />} />
            </Route>
          </Route>
          {/* Recursos humanos y nomina (modulo rh) */}
          <Route element={<ModuleGate code="rh" name="Recursos humanos" />}>
            <Route path="rh" element={<RhLayout />}>
              <Route index element={<EmployeesPage />} />
              <Route element={<ModuleGate code="turnos" name="Turnos y rol semanal" />}>
                <Route path="turnos" element={<ShiftsPage />} />
              </Route>
              <Route path="asistencia" element={<AttendancePage />} />
              <Route path="nomina" element={<PayrollPage />} />
              <Route path="nomina/:id" element={<PayrollPeriodPage />} />
              <Route path="aclaraciones" element={<ClaimsPage />} />
              <Route path="aguinaldo" element={<AguinaldoPage />} />
              <Route path="incidencias" element={<IncidentsPage />} />
              <Route path="comunicados" element={<AnnouncementsPage />} />
              <Route path="ajustes" element={<RhSettingsPage />} />
            </Route>
            <Route path="checador" element={<KioskPage />} />
            <Route path="checklists" element={<ChecklistsPage />} />
            <Route path="mi-nomina" element={<MyPayrollPage />} />
          </Route>
          {/* Domicilios (modulo domicilios) */}
          <Route element={<ModuleGate code="domicilios" name="Domicilios" />}>
            <Route path="reparto" element={<DispatchPage />} />
            <Route path="reparto/cortes" element={<DriverCutsPage />} />
            <Route path="domicilios" element={<DeliverySettingsPage />} />
          </Route>
          {/* Chat del equipo (modulo chat) */}
          <Route element={<ModuleGate code="chat" name="Chat del equipo" />}>
            <Route path="chat" element={<ChatPage />} />
          </Route>
          {/* Apartados y metas de aguinaldo (modulo apartados) */}
          <Route element={<ModuleGate code="apartados" name="Apartados y aguinaldo" />}>
            <Route path="apartados" element={<SavingsPage />} />
            <Route path="apartados/:id" element={<SavingsDetailPage />} />
          </Route>
          {/* Bot de WhatsApp (modulo whatsapp) */}
          <Route element={<ModuleGate code="whatsapp" name="Bot de WhatsApp" />}>
            <Route path="whatsapp" element={<WhatsAppPage />} />
          </Route>
          {/* Calificaciones y quejas (modulo quejas) */}
          <Route element={<ModuleGate code="quejas" name="Calificaciones y quejas" />}>
            <Route path="quejas" element={<FeedbackPage />} />
          </Route>
          {/* Empleado del mes (modulo empleado_mes) */}
          <Route element={<ModuleGate code="empleado_mes" name="Empleado del mes" />}>
            <Route path="empleado-del-mes" element={<RecognitionPage />} />
            <Route path="empleado-del-mes/empleados" element={<EmployeesPage />} />
            <Route path="muro" element={<WallPage />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
