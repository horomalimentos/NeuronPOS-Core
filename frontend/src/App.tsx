import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import DeliverySettingsPage from './delivery/DeliverySettingsPage';
import DispatchPage from './delivery/DispatchPage';
import DriverCutsPage from './delivery/DriverCutsPage';
import DriverApp from './driver/DriverApp';
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
import ReportsPage from './pos/ReportsPage';
import RegisterPage from './pos/RegisterPage';
import TablesAdminPage from './pos/TablesAdminPage';
import PlatformLogin from './platform/PlatformLogin';
import PlatformSettingsPage from './platform/PlatformSettingsPage';
import RestaurantDetailPage from './platform/RestaurantDetailPage';
import RestaurantsPage from './platform/RestaurantsPage';
import AdminLayout from './restaurant/AdminLayout';
import BranchesPage from './restaurant/BranchesPage';
import DashboardPage from './restaurant/DashboardPage';
import FeedbackPage from './restaurant/FeedbackPage';
import RestaurantLogin from './restaurant/RestaurantLogin';
import { StaffForgotPage, StaffResetPage } from './restaurant/StaffPasswordPages';
import SubscriptionPage from './restaurant/SubscriptionPage';
import OnlineSettingsPage from './restaurant/OnlineSettingsPage';
import UsersPage from './restaurant/UsersPage';
import WebsitePage from './restaurant/WebsitePage';
import AttendancePage from './rh/AttendancePage';
import EmployeesPage from './rh/EmployeesPage';
import KioskPage from './rh/KioskPage';
import ModuleGate from './rh/ModuleGate';
import MyPayrollPage from './rh/MyPayrollPage';
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
import OrderPage from './site/OrderPage';
import PaymentResultPage from './site/PaymentResultPage';
import PublicSite from './site/PublicSite';
import SiteLayout from './site/SiteLayout';
import TrackOrderPage from './site/TrackOrderPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Sitio publico y portal de clientes del restaurante (por dominio) */}
        <Route element={<SiteLayout />}>
          <Route path="/" element={<PublicSite />} />
          <Route path="/pedir" element={<OrderPage />} />
          <Route path="/pedir/checkout" element={<CheckoutPage />} />
          <Route path="/pedido/:token" element={<TrackOrderPage />} />
          <Route path="/pago/resultado" element={<PaymentResultPage />} />
          <Route path="/cuenta" element={<AccountPage />} />
          <Route path="/cuenta/entrar" element={<LoginPage />} />
          <Route path="/cuenta/registro" element={<CustomerRegisterPage />} />
          <Route path="/cuenta/olvide" element={<ForgotPasswordPage />} />
          <Route path="/cuenta/restablecer" element={<ResetPasswordPage />} />
          <Route path="/cuenta/pedidos" element={<OrdersPage />} />
        </Route>

        {/* Instaladores de NeuronPOS y Neuron KDS */}
        <Route path="/descargas" element={<DownloadsPage />} />

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
          <Route path="ajustes" element={<PlatformSettingsPage />} />
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
            <Route path="menu" element={<MenuAdminPage />} />
            <Route path="mesas" element={<TablesAdminPage />} />
            <Route path="pos/ajustes" element={<PosSettingsPage />} />
            <Route element={<ModuleGate code="reportes" name="Reportes de ventas" />}>
              <Route path="reportes" element={<ReportsPage />} />
            </Route>
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
              <Route path="ajustes" element={<RhSettingsPage />} />
            </Route>
            <Route path="checador" element={<KioskPage />} />
            <Route path="mi-nomina" element={<MyPayrollPage />} />
          </Route>
          {/* Domicilios (modulo domicilios) */}
          <Route element={<ModuleGate code="domicilios" name="Domicilios" />}>
            <Route path="reparto" element={<DispatchPage />} />
            <Route path="reparto/cortes" element={<DriverCutsPage />} />
            <Route path="domicilios" element={<DeliverySettingsPage />} />
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
