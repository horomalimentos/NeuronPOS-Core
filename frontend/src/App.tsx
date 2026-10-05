import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
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
import RestaurantDetailPage from './platform/RestaurantDetailPage';
import RestaurantsPage from './platform/RestaurantsPage';
import AdminLayout from './restaurant/AdminLayout';
import BranchesPage from './restaurant/BranchesPage';
import DashboardPage from './restaurant/DashboardPage';
import RestaurantLogin from './restaurant/RestaurantLogin';
import OnlineSettingsPage from './restaurant/OnlineSettingsPage';
import UsersPage from './restaurant/UsersPage';
import WebsitePage from './restaurant/WebsitePage';
import { AccountPage, LoginPage, OrdersPage, RegisterPage as CustomerRegisterPage } from './site/AccountPages';
import CheckoutPage from './site/CheckoutPage';
import OrderPage from './site/OrderPage';
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
        </Route>

        {/* Administracion del restaurante */}
        <Route path="/admin/login" element={<RestaurantLogin />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="sucursales" element={<BranchesPage />} />
          <Route path="usuarios" element={<UsersPage />} />
          <Route path="sitio" element={<WebsitePage />} />
          <Route path="pedidos-en-linea" element={<OnlineSettingsPage />} />
          {/* Punto de venta (modulo pos) */}
          <Route element={<PosGate />}>
            <Route path="pos" element={<RegisterPage />} />
            <Route path="cocina" element={<KitchenPage />} />
            <Route path="caja" element={<CashPage />} />
            <Route path="menu" element={<MenuAdminPage />} />
            <Route path="mesas" element={<TablesAdminPage />} />
            <Route path="pos/ajustes" element={<PosSettingsPage />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
