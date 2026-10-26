/** Locations without a status describe currently available content. */
export function isAvailableLocation(location) {
    return Boolean(location?.url) && (location.status == null || location.status === 'available');
}

export function availableLocations(document) {
    return (document?.locations || []).filter(isAvailableLocation);
}
