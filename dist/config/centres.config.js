"use strict";
/**
 * VFS France Centre Configuration
 *
 * This file maps all 18 VFS France centres across India to their exact
 * dropdown text for Application Centre, Appointment Category, and Appointment Subcategory.
 *
 * CRITICAL: Text must match EXACTLY (case-sensitive, spaces, punctuation)
 * Angular Material dropdowns use strict === matching.
 *
 * How to update this config:
 * 1. Open VFS booking page in a clean browser
 * 2. For each centre, select it from the dropdown
 * 3. Copy the EXACT text from category and subcategory dropdowns
 * 4. Update the config below
 *
 * Note: Only tourism visa subcategories are configured.
 * Other visa types can be added later if needed.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CENTRES = void 0;
/**
 * All 18 VFS France centres in India
 *
 * TODO: Fill in exact dropdown text for each centre by manually testing
 * Current data is placeholder — needs verification from actual booking page
 */
exports.CENTRES = [
    {
        name: 'France Temporary Enrolment Centre-Mangalore',
        category: null,
        subcategory: 'Short Stay- Tourism/Visiting Family and Friends/Any other short stay',
    },
    {
        name: 'France Temporary Enrolment Centre-Vishakhapatnam',
        category: null,
        subcategory: 'Short stay-Tourism/Visiting family and friends/Any other short stay',
    },
    {
        name: 'France Visa Application Center, Guwahati',
        category: null,
        subcategory: 'Tourist',
    },
    {
        name: 'France Visa Application Centre Pune',
        category: 'Default_France_India',
        subcategory: 'Tourist',
    },
    {
        name: 'France Visa Application Centre, Ahmedabad',
        category: 'Default_France_India',
        subcategory: 'Tourist',
    },
    {
        name: 'France Visa Application Centre, Bangalore',
        category: 'Default_France_India',
        subcategory: 'Short Stay- Tourism/Visiting Family and Friends/Any other short stay',
    },
    {
        name: 'France Visa Application Centre, Chandigarh',
        category: null,
        subcategory: 'Tourist',
    },
    {
        name: 'France Visa Application Centre, Chennai',
        category: null,
        subcategory: 'Short Stay- Tourism/Visiting Family and Friends/Any other short stay',
    },
    {
        name: 'France Visa Application Centre, Cochin',
        category: null,
        subcategory: 'Short stay-Tourism/Visiting family and friends/Any other short stay',
    },
    {
        name: 'France Visa Application Centre, Coimbatore',
        category: null,
        subcategory: 'Short Stay- Tourism/Visiting Family and Friends/Any other short stay',
    },
    {
        name: 'France Visa Application Centre, Goa',
        category: 'Default_France_India',
        subcategory: 'Tourist',
    },
    {
        name: 'France Visa Application Centre, Hyderabad',
        category: null,
        subcategory: 'Short Stay- Tourism/Visiting Family and Friends/Any other short stay',
    },
    {
        name: 'France Visa Application Centre, Jaipur',
        category: null,
        subcategory: 'Tourist',
    },
    {
        name: 'France Visa Application Centre, Jalandhar',
        category: null,
        subcategory: 'Tourist',
    },
    {
        name: 'France Visa Application Centre, Kolkata',
        category: null,
        subcategory: 'Tourist',
    },
    {
        name: 'France Visa Application Centre, Mumbai',
        category: 'Default_France_India',
        subcategory: 'Tourist',
    },
    {
        name: 'France Visa Application Centre, New Delhi',
        category: null,
        subcategory: 'Tourist',
    },
    {
        name: 'France Visa Application Centre, Puducherry',
        category: null,
        subcategory: 'Short stay-Tourism/Visiting family and friends/Any other short stay',
    },
];
//# sourceMappingURL=centres.config.js.map