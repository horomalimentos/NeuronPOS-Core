import { BarChart3, Boxes, ChefHat, DollarSign, Gift, HeartHandshake, Wallet, Bike, Globe, Monitor, Star, Store, Users, type LucideIcon, ShoppingBag, Package } from 'lucide-react';

export const MODULE_ICONS: Record<string, LucideIcon> = {
  pos: Monitor,
  reportes: BarChart3,
  inventario: Boxes,
  lealtad: HeartHandshake,
  monedero: Wallet,
  landing: Globe,
  portal: ShoppingBag,
  rh: Users,
  empleado_mes: Star,
  domicilios: Bike,
  estaciones: ChefHat,
  plataformas: Store,
  promociones: Gift,
  multimoneda: DollarSign,
  terminal_clip: CreditCard,
};

export const moduleIcon = (code: string): LucideIcon => MODULE_ICONS[code] || Package;
