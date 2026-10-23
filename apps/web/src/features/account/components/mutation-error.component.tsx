import { MutationAlert } from '../../../components/mutation-alert.component';
import { useOwnAccount } from '../account.helper';
import { StepUpAction } from './step-up-action.component';

/**
 * Write failure with the step-up the account flow offers on a 403 (ADR 0016 TD5, ADR 0026,
 * ADR 0027 §7): the two-step code for an account with a second factor, else the way to set one up.
 */
export function MutationError(props: { readonly error: unknown }) {
  const secondFactor = useOwnAccount().data?.mfa.status === 'enabled';
  return (
    <MutationAlert error={props.error} secondFactor={secondFactor} stepUp={<StepUpAction />} />
  );
}
