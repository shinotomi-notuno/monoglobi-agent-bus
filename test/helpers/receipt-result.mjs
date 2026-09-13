// replayed is response metadata; current active status remains compared.
export function historicalResult(value) {
 if(!value || Array.isArray(value) || typeof value!=='object')return value;
 const {replayed,...result}=value;return result;
}
