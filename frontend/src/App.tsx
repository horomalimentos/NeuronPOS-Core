import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import ModulesCatalogPage from './platform/ModulesCatalogPage';
import PlatformLayout from './platform/PlatformLayout';
import PlatformLogin from './platform/PlatformLogin';
import RestaurantDetailPage from './platform/RestaurantDetailPage';
import RestaurantsPage from './platform/RestaurantsPage';
import AdminLayout from './restaurant/AdminLayout';
import BranchesPage from './restaurant/BranchesPage';
import DashboardPage from './restaurant/DashboardPage';
import RestaurantLogin from './restaurant/RestaurantLogin';
import UsersPage from './restaurant/UsersPage';
import PublicSite from './site/PublicSite';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<PublicSite />} />

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
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
