import { BarChart3, Bike, Globe, Monitor, Star, Users, type LucideIcon, ShoppingBag, Package } from 'lucide-react';

export const MODULE_ICONS: Record<string, LucideIcon> = {
  pos: Monitor,
  reportes: BarChart3,
  landing: Globe,
  portal: ShoppingBag,
  rh: Users,
  empleado_mes: Star,
  domicilios: Bike,
};

export const moduleIcon = (code: string): LucideIcon => MODULE_ICONS[code] || Package;
