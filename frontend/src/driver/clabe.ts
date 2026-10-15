// CLABE interbancaria (igual que backend/services/clabe.js): 18 digitos, los
// 3 primeros son el banco y el ultimo el digito verificador.
const BANKS: Record<string, string> = {
  '002': 'Banamex', '012': 'BBVA', '014': 'Santander', '021': 'HSBC', '030': 'BanBajío', '036': 'Inbursa',
  '044': 'Scotiabank', '058': 'Banregio', '062': 'Afirme', '072': 'Banorte', '127': 'Banco Azteca',
  '137': 'BanCoppel', '638': 'Nu México', '646': 'STP', '722': 'Mercado Pago',
};

export const clabeDigits = (v: string) => v.replace(/\D/g, '').slice(0, 18);
export const clabeBank = (clabe: string) => BANKS[clabe.slice(0, 3)] ?? null;

export function clabeIsValid(clabe: string) {
  if (!/^\d{18}$/.test(clabe)) return false;
  const w = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (Number(clabe[i]) * w[i % 3]) % 10;
  return (10 - (sum % 10)) % 10 === Number(clabe[17]);
}

/** "0121 8000 1234 5678 99" para leerla mejor. */
export const clabeGroups = (clabe: string) => clabe.replace(/(\d{4})(?=\d)/g, '$1 ');
export const clabeMasked = (clabe: string) => `•••• ${clabe.slice(-4)}`;

export interface BankInfo { bank_name: string | null; bank_clabe: string | null; bank_holder: string | null; bank_updated_at: string | null }
