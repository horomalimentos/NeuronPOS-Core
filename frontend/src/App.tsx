import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import InvoicesPage from './platform/InvoicesPage';
import ModulesCatalogPage from './platform/ModulesCatalogPage';
import PlatformLayout from './platform/PlatformLayout';
import CashPage from './pos/CashPage';
import KitchenPage from './pos/KitchenPage';
import MenuAdminPage from './pos/MenuAdminPage';
import PosGate from './pos/PosGate';
import PosSettingsPage from './pos/PosSettingsPage';
import RegisterPage from './pos/RegisterPage';
import TablesAdminPage from './pos/TablesAdminPage';
import PlatformLogin from './platform/PlatformLogin';
import PlatformSettingsPage from './platform/PlatformSettingsPage';
import RestaurantDetailPage from './platform/RestaurantDetailPage';
import RestaurantsPage from './platform/RestaurantsPage';
import AdminLayout from './restaurant/AdminLayout';
import BranchesPage from './restaurant/BranchesPage';
import DashboardPage from './restaurant/DashboardPage';
import RestaurantLogin from './restaurant/RestaurantLogin';
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
import WallPage from './rh/WallPage';
import { AccountPage, LoginPage, OrdersPage, RegisterPage as CustomerRegisterPage } from './site/AccountPages';
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
          <Route path="/cuenta/pedidos" element={<OrdersPage />} />
        </Route>

        {/* Panel NeuronPOS (dueno de la plataforma) */}
        <Route path="/panel/login" element={<PlatformLogin />} />
        <Route path="/panel" element={<PlatformLayout />}>
          <Route index element={<RestaurantsPage />} />
          <Route path="restaurantes/:id" element={<RestaurantDetailPage />} />
          <Route path="modulos" element={<ModulesCatalogPage />} />
          <Route path="cobros" element={<InvoicesPage />} />
          <Route path="ajustes" element={<PlatformSettingsPage />} />
        </Route>

        {/* Administracion del restaurante */}
        <Route path="/admin/login" element={<RestaurantLogin />} />
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
          </Route>
          {/* Recursos humanos y nomina (modulo rh) */}
          <Route element={<ModuleGate code="rh" name="Recursos humanos" />}>
            <Route path="rh" element={<RhLayout />}>
              <Route index element={<EmployeesPage />} />
              <Route path="asistencia" element={<AttendancePage />} />
              <Route path="nomina" element={<PayrollPage />} />
              <Route path="nomina/:id" element={<PayrollPeriodPage />} />
              <Route path="ajustes" element={<RhSettingsPage />} />
            </Route>
            <Route path="checador" element={<KioskPage />} />
            <Route path="mi-nomina" element={<MyPayrollPage />} />
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
