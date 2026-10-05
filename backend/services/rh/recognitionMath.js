// Puntaje y ranking del empleado del mes. Puro y determinista: los
// componentes se llevan en centesimas enteras (0 a 10000 = 0.00 a 100.00) y
// el empate se rompe siempre igual.
//
// Componentes (0 a 100 cada uno), con los pesos de recognition_settings:
//   - asistencia: dias laborales con asistencia (o falta justificada) / dias
//     laborales ya pasados. Requiere el modulo rh.
//   - puntualidad: dias trabajados sin retardo injustificado / dias trabajados.
//     Requiere el modulo rh.
//   - ventas: ventas cobradas del usuario del empleado / la mayor venta de su
//     sucursal. Solo para empleados con usuario mesero o cajero (a los demas
//     no se les cuenta ese peso). Requiere el modulo pos.
//   - evaluacion: promedio de las evaluaciones del gerente (0 a 100; sin
//     evaluacion = 0).
//   - tareas: puntos de tareas completadas / el mayor de su sucursal.
// Puntaje = suma(peso x componente) / suma(pesos de los componentes que le
// aplican). Un componente que no aplica (modulo no contratado, o sin dias
// laborales) no cuenta ni a favor ni en contra.

export const COMPONENTS = ['attendance', 'punctuality', 'sales', 'evaluation', 'tasks'];
export const COMPONENT_LABEL = {
  attendance: 'Asistencia', punctuality: 'Puntualidad', sales: 'Ventas', evaluation: 'Evaluación', tasks: 'Tareas',
};
export const SALES_ROLES = ['mesero', 'cajero'];

const ratio = (num, den) => (den > 0 ? Math.round((num * 10000) / den) : 0);

/**
 * employees: [{ id, full_name, branch_id, user_role }]
 * data: {
 *   attendance: Map id -> { scheduled, present, worked, tardies } | null (sin rh),
 *   sales: Map id -> centavos | null (sin pos),
 *   evaluations: Map id -> promedio 0..100,
 *   tasks: Map id -> puntos,
 * }
 * weights: { attendance, punctuality, sales, evaluation, tasks }
 */
export function computeRanking({ employees, data, weights, minDaysWorked = 0 }) {
  const maxBy = (map) => {
    const out = new Map();
    for (const e of employees) {
      const v = map?.get(e.id) || 0;
      out.set(e.branch_id, Math.max(out.get(e.branch_id) || 0, v));
    }
    return out;
  };
  const salesMax = data.sales ? maxBy(new Map(employees.filter((e) => SALES_ROLES.includes(e.user_role)).map((e) => [e.id, data.sales.get(e.id) || 0]))) : null;
  const tasksMax = maxBy(data.tasks || new Map());

  const rows = employees.map((e) => {
    const c = {};
    const att = data.attendance ? (data.attendance.get(e.id) || { scheduled: 0, present: 0, worked: 0, tardies: 0 }) : null;
    c.attendance = att && att.scheduled > 0 ? ratio(att.present, att.scheduled) : null;
    c.punctuality = att && att.worked > 0 ? ratio(att.worked - att.tardies, att.worked) : null;
    c.sales = data.sales && SALES_ROLES.includes(e.user_role) ? ratio(data.sales.get(e.id) || 0, salesMax.get(e.branch_id) || 0) : null;
    c.evaluation = Math.round(Number(data.evaluations?.get(e.id) || 0) * 100);
    c.tasks = ratio(data.tasks?.get(e.id) || 0, tasksMax.get(e.branch_id) || 0);
    let num = 0;
    let den = 0;
    for (const k of COMPONENTS) {
      const w = Number(weights[k] || 0);
      if (w > 0 && c[k] !== null) { num += w * c[k]; den += w; }
    }
    const score = den > 0 ? Math.round(num / den) : 0;
    return {
      employee_id: e.id,
      employee_name: e.full_name,
      branch_id: e.branch_id,
      score: score / 100,
      score_hundredths: score,
      components: Object.fromEntries(COMPONENTS.map((k) => [k, c[k] === null ? null : c[k] / 100])),
      days_worked: att ? att.worked : null,
      eligible: score > 0 && (!att || att.worked >= minDaysWorked),
    };
  });

  const nz = (v) => (v === null ? -1 : v);
  rows.sort((a, b) => a.branch_id.localeCompare(b.branch_id)
    || b.score_hundredths - a.score_hundredths
    || nz(b.components.attendance) - nz(a.components.attendance)
    || nz(b.components.punctuality) - nz(a.components.punctuality)
    || a.employee_name.localeCompare(b.employee_name, 'es')
    || a.employee_id.localeCompare(b.employee_id));

  const rankByBranch = new Map();
  const winners = new Set();
  for (const r of rows) {
    const rank = (rankByBranch.get(r.branch_id) || 0) + 1;
    rankByBranch.set(r.branch_id, rank);
    r.rank = rank;
    r.is_winner = false;
    if (r.eligible && !winners.has(r.branch_id)) {
      r.is_winner = true;
      winners.add(r.branch_id);
    }
    delete r.score_hundredths;
  }
  return rows;
}
