import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50 cursor-pointer select-none',
  {
    variants: {
      variant: {
        primary: 'bg-brand-500 text-white hover:bg-brand-600 active:bg-brand-700',
        secondary: 'border border-line-strong bg-white text-ink hover:bg-canvas active:bg-line',
        ghost: 'text-brand-600 hover:bg-brand-50',
        danger: 'bg-danger text-white hover:bg-[#8e1f25]',
        command: 'text-ink hover:bg-canvas px-3 font-normal',
      },
      size: { default: 'h-8 px-4', lg: 'h-10 px-6', sm: 'h-7 px-3 text-xs' },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
)
Button.displayName = 'Button'
export { buttonVariants }
