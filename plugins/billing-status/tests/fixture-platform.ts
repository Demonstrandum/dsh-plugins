// The isolated fixture exercises the same platform hook implementation as DSH.
export { useAnchoredPosition } from '../../../deepseek-harness/packages/client/ui-primitives/src/useAnchoredPosition.ts'
export { useDismissOnOutsidePointer } from '../../../deepseek-harness/packages/client/ui-primitives/src/useDismissOnOutsidePointer.ts'
export { IconInfoOutline14, IconWarningOutline16 } from '../../../deepseek-harness/packages/client/ui-primitives/src/icons/index.tsx'
// The platform Tooltip needs DSH's CSS-module pipeline; the fixture shows its children only.
export function Tooltip({ children }: { children: import('react').ReactNode }) { return children }
