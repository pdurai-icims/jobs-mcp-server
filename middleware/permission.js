export function hasPermission(user, permission) {
    return (
        Array.isArray(user?.permissions) &&
        user.permissions.includes(permission)
    );
}