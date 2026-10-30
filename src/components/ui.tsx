import { forwardRef } from 'react';
import {
  Button as AriaButton,
  Input as AriaInput,
  TextField,
} from 'react-aria-components';
import type { ButtonProps as AriaButtonProps } from 'react-aria-components';

type AppButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'disabled'> & {
  /** Keep existing app callbacks while routing activation through React Aria's press model. */
  onClick?: () => void;
  disabled?: boolean;
  isPending?: AriaButtonProps['isPending'];
};

export const AppButton = forwardRef<HTMLButtonElement, AppButtonProps>(function AppButton(
  { onClick, disabled, className, ...props },
  ref,
) {
  return <AriaButton {...(props as AriaButtonProps)} ref={ref} className={`button-base ${className ?? ''}`} data-variant="quiet" isDisabled={disabled} onPress={onClick} />;
});

type AppInputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const AppInput = forwardRef<HTMLInputElement, AppInputProps>(function AppInput(
  { 'aria-label': ariaLabel, className, ...props },
  ref,
) {
  return (
    <TextField className="aria-field" aria-label={ariaLabel}>
      <AriaInput {...props} ref={ref} className={className} />
    </TextField>
  );
});
