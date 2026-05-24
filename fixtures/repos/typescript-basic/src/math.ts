export class Calculator {
  add(left: number, right: number): number {
    return left + right;
  }
}

export function add(left: number, right: number): number {
  return new Calculator().add(left, right);
}

const total = add(1, 2);
console.log(total);
