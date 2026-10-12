import { BarChart3, Boxes, CalendarHeart, ChefHat, CreditCard, DollarSign, Gift, HeartHandshake, Wallet, Bike, Globe, Monitor, MonitorSmartphone, Star, Store, Users, type LucideIcon, ShoppingBag, Package, TabletSmartphone, MessagesSquare, PiggyBank } from 'lucide-react';

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
  kiosko: TabletSmartphone,
  dispositivos: MonitorSmartphone,
  eventos: CalendarHeart,
  chat: MessagesSquare,
  apartados: PiggyBank,
};

export const moduleIcon = (code: string): LucideIcon => MODULE_ICONS[code] || Package;
