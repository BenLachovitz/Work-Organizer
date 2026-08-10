/** Ben is the manager AND an active guard -- he never got a separate demo
 *  account, so he must show up regardless of which view mode is selected. */
export const BEN_EMPLOYEE_CODE = '005396';

export type ViewMode = 'real' | 'test';

/** Whether a guard/employee row should show under the given admin view mode.
 *  Ben is exempt from the split entirely; everyone else follows is_demo. */
export function visibleToViewMode(
  employee: { employee_code: string; is_demo: boolean },
  mode: ViewMode,
): boolean {
  if (employee.employee_code === BEN_EMPLOYEE_CODE) return true;
  return mode === 'test' ? employee.is_demo : !employee.is_demo;
}
