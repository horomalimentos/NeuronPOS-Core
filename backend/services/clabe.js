// CLABE interbancaria (18 digitos): los 3 primeros son el banco y el ultimo
// es el digito verificador (pesos 3, 7, 1 sobre los 17 primeros, modulo 10).

// Bancos comunes por su clave; si no esta, el repartidor escribe el nombre.
export const CLABE_BANKS = {
  '002': 'Banamex', '012': 'BBVA', '014': 'Santander', '021': 'HSBC', '030': 'BanBajío', '036': 'Inbursa',
  '044': 'Scotiabank', '058': 'Banregio', '062': 'Afirme', '072': 'Banorte', '127': 'Banco Azteca',
  '137': 'BanCoppel', '638': 'Nu México', '646': 'STP', '722': 'Mercado Pago',
};

export function clabeIsValid(clabe) {
  if (!/^\d{18}$/.test(clabe)) return false;
  const w = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (Number(clabe[i]) * w[i % 3]) % 10;
  return (10 - (sum % 10)) % 10 === Number(clabe[17]);
}

export const clabeBank = (clabe) => CLABE_BANKS[String(clabe).slice(0, 3)] ?? null;
