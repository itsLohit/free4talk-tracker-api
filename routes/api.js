const express = require('express');
const router = express.Router();
const pool = require('../db');

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Record profile view when user profile is accessed
 */
async function recordProfileView(userId, req) {
    try {
        const viewerIp = req.ip || req.connection.remoteAddress || 'unknown';
        const viewerUserAgent = req.get('User-Agent') || 'Unknown';

        await pool.query(
            `INSERT INTO profile_views (viewed_user_id, viewer_ip, viewer_user_agent, viewed_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT DO NOTHING`,
            [userId, viewerIp.substring(0, 50), viewerUserAgent.substring(0, 255)]
        );
    } catch (error) {
        // Silently fail - don't break the request if view recording fails
        console.error('Failed to record profile view:', error.message);
    }
}

// ============================================
// 1. SEARCH USERS (ENHANCED WITH FUZZY SEARCH)
// ============================================
router.get('/users/search', async (req, res) => {
    try {
        const { q, limit = 20 } = req.query;

        if (!q || q.length < 2) {
            return res.json([]);
        }

        const query = `
            SELECT 
                user_id,
                username,
                user_avatar,
                followers_count,
                following_count,
                friends_count,
                verification_status,
                supporter_level,
                last_seen,
                total_sessions
            FROM users
            WHERE 
                LOWER(username) LIKE LOWER($1) OR
                LOWER(user_id) LIKE LOWER($1)
            ORDER BY 
                CASE 
                    WHEN LOWER(username) = LOWER($2) THEN 1
                    WHEN LOWER(username) LIKE LOWER($3) THEN 2
                    ELSE 3
                END,
                followers_count DESC NULLS LAST,
                total_sessions DESC NULLS LAST
            LIMIT $4
        `;

        const searchTerm = `%${q}%`;
        const exactTerm = q;
        const startsWithTerm = `${q}%`;

        const result = await pool.query(query, [searchTerm, exactTerm, startsWithTerm, limit]);
        res.json(result.rows);

    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'Search failed', details: error.message });
    }
});

// ============================================
// 2. GET USER PROFILE (ENHANCED)
// ============================================
router.get('/users/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { record_view = 'false' } = req.query;

        // Get user basic info with all enhanced fields
        const userQuery = `
            SELECT 
                user_id,
                username,
                user_avatar,
                followers_count,
                following_count,
                friends_count,
                supporter_level,
                verification_status,
                first_seen,
                last_seen,
                profile_views_count,
                total_sessions,
                total_duration_seconds,
                created_at,
                updated_at
            FROM users
            WHERE user_id = $1 OR LOWER(username) = LOWER($1)
        `;

        const userResult = await pool.query(userQuery, [userId]);

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = userResult.rows[0];

        // Get user statistics
        const statsQuery = `
            SELECT 
                COUNT(DISTINCT room_id) as total_rooms_visited,
                COUNT(DISTINCT session_id) as total_sessions,
                COALESCE(SUM(duration_seconds), 0)::BIGINT as total_duration_seconds,
                COALESCE(AVG(duration_seconds), 0)::INTEGER as avg_session_duration,
                MAX(joined_at) as last_active,
                COUNT(CASE WHEN is_currently_active THEN 1 END) > 0 as is_currently_active
            FROM sessions
            WHERE user_id = $1
        `;
        const statsResult = await pool.query(statsQuery, [user.user_id]);
        const stats = statsResult.rows[0] || {};

        // Get favorite language
        const favLangQuery = `
            SELECT r.language, COUNT(*) as visit_count
            FROM sessions s
            JOIN rooms r ON s.room_id = r.room_id
            WHERE s.user_id = $1
            GROUP BY r.language
            ORDER BY visit_count DESC
            LIMIT 1
        `;
        const favLangResult = await pool.query(favLangQuery, [user.user_id]);
        const favoriteLanguage = favLangResult.rows[0]?.language || null;

        // Record profile view if requested
        if (record_view === 'true') {
            await recordProfileView(user.user_id, req);
        }

        res.json({
            ...user,
            // Ensure null safety
            followers_count: user.followers_count || 0,
            following_count: user.following_count || 0,
            friends_count: user.friends_count || 0,
            supporter_level: user.supporter_level || 0,
            profile_views_count: user.profile_views_count || 0,
            total_sessions: user.total_sessions || 0,
            total_duration_seconds: user.total_duration_seconds || 0,
            // Add computed statistics
            statistics: {
                total_rooms_visited: parseInt(stats.total_rooms_visited) || 0,
                total_sessions: parseInt(stats.total_sessions) || 0,
                total_duration_seconds: parseInt(stats.total_duration_seconds) || 0,
                avg_session_duration: parseInt(stats.avg_session_duration) || 0,
                favorite_language: favoriteLanguage,
                last_active: stats.last_active || user.last_seen,
                is_currently_active: stats.is_currently_active || false
            }
        });

    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: 'Failed to get user', details: error.message });
    }
});

// ============================================
// 3. GET USER PROFILE HISTORY (NEW)
// ============================================
router.get('/users/:userId/history', async (req, res) => {
    try {
        const { userId } = req.params;
        const { limit = 50, type = 'all' } = req.query;

        const query = `
            SELECT 
                log_id,
                activity_type,
                activity_data,
                activity_time
            FROM user_activity_log
            WHERE user_id = $1 
                AND ($2 = 'all' OR activity_type = $2)
            ORDER BY activity_time DESC
            LIMIT $3
        `;

        const result = await pool.query(query, [userId, type, limit]);

        // Parse JSON data for easier consumption
        const formattedResults = result.rows.map(row => ({
            ...row,
            activity_data: typeof row.activity_data === 'string' 
                ? JSON.parse(row.activity_data) 
                : row.activity_data
        }));

        res.json(formattedResults);

    } catch (error) {
        console.error('Get user history error:', error);
        res.status(500).json({ error: 'Failed to get user history', details: error.message });
    }
});

// ============================================
// 4. GET USER ROOM HISTORY (ENHANCED)
// ============================================
router.get('/users/:userId/rooms', async (req, res) => {
    try {
        const { userId } = req.params;
        const { limit = 50, offset = 0, language, skill_level } = req.query;

        let whereClause = 's.user_id = $1';
        const params = [userId];
        let paramCount = 1;

        if (language) {
            paramCount++;
            whereClause += ` AND r.language = $${paramCount}`;
            params.push(language);
        }

        if (skill_level) {
            paramCount++;
            whereClause += ` AND r.skill_level = $${paramCount}`;
            params.push(skill_level);
        }

        const query = `
            SELECT 
                r.room_id,
                r.language,
                r.second_language,
                r.skill_level,
                r.topic,
                r.is_active,
                r.current_users_count,
                r.max_capacity,
                MAX(s.joined_at) as last_visit,
                MIN(s.joined_at) as first_visit,
                COUNT(s.session_id) as total_visits,
                SUM(s.duration_seconds) as total_time_seconds,
                AVG(s.duration_seconds)::INTEGER as avg_session_duration
            FROM sessions s
            JOIN rooms r ON s.room_id = r.room_id
            WHERE ${whereClause}
            GROUP BY r.room_id, r.language, r.second_language, r.skill_level, r.topic, r.is_active, r.current_users_count, r.max_capacity
            ORDER BY last_visit DESC
            LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
        `;

        params.push(limit, offset);
        const result = await pool.query(query, params);

        // Get total count
        const countQuery = `
            SELECT COUNT(DISTINCT s.room_id) as total
            FROM sessions s
            JOIN rooms r ON s.room_id = r.room_id
            WHERE ${whereClause}
        `;
        const countResult = await pool.query(countQuery, params.slice(0, paramCount));

        res.json({
            rooms: result.rows,
            pagination: {
                total: parseInt(countResult.rows[0].total),
                limit: parseInt(limit),
                offset: parseInt(offset),
                has_more: parseInt(offset) + result.rows.length < parseInt(countResult.rows[0].total)
            }
        });

    } catch (error) {
        console.error('Get rooms error:', error);
        res.status(500).json({ error: 'Failed to get rooms', details: error.message });
    }
});

// ============================================
// 5. GET USER SESSIONS IN A ROOM (FIXED)
// ============================================
router.get('/users/:userId/rooms/:roomId/sessions', async (req, res) => {
    try {
        const { userId, roomId } = req.params;
        const { limit = 100, offset = 0 } = req.query;

        const query = `
            SELECT
                session_id,
                joined_at,
                left_at,
                duration_seconds,
                is_currently_active,
                event_type,
                user_position,
                mic_was_on
            FROM sessions
            WHERE user_id = $1 AND room_id = $2
            ORDER BY joined_at DESC
            LIMIT $3 OFFSET $4
        `;

        const result = await pool.query(query, [userId, roomId, limit, offset]);
        res.json(result.rows);

    } catch (error) {
        console.error('Get sessions error:', error);
        res.status(500).json({ error: 'Failed to get sessions', details: error.message });
    }
});

// ============================================
// 6. GET ROOM DETAILS (ENHANCED)
// ============================================
router.get('/rooms/:roomId', async (req, res) => {
    try {
        const { roomId } = req.params;

        // Get room basic info with all fields
        const roomQuery = `
            SELECT 
                room_id,
                channel,
                platform,
                topic,
                language,
                second_language,
                skill_level,
                max_capacity,
                allows_unlimited,
                is_locked,
                mic_allowed,
                mic_required,
                no_mic,
                al_mic,
                url,
                creator_user_id,
                creator_name,
                creator_avatar,
                creator_is_verified,
                is_active,
                is_full,
                is_empty,
                current_users_count,
                first_seen,
                last_activity,
                created_at,
                updated_at
            FROM rooms
            WHERE room_id = $1
        `;

        const roomResult = await pool.query(roomQuery, [roomId]);

        if (roomResult.rows.length === 0) {
            return res.status(404).json({ error: 'Room not found' });
        }

        // Get room statistics
        const statsQuery = `
            SELECT 
                COUNT(DISTINCT user_id) as total_unique_participants,
                COUNT(session_id) as total_sessions,
                COALESCE(AVG(duration_seconds), 0)::INTEGER as avg_duration_seconds,
                COALESCE(MAX(duration_seconds), 0) as max_duration_seconds,
                MIN(joined_at) as first_activity,
                MAX(COALESCE(left_at, joined_at)) as last_activity,
                COUNT(CASE WHEN is_currently_active THEN 1 END) as currently_active_users
            FROM sessions
            WHERE room_id = $1
        `;
        const statsResult = await pool.query(statsQuery, [roomId]);
        const stats = statsResult.rows[0] || {};

        const room = roomResult.rows[0];

        res.json({
            ...room,
            statistics: {
                total_unique_participants: parseInt(stats.total_unique_participants) || 0,
                total_sessions: parseInt(stats.total_sessions) || 0,
                avg_duration_seconds: parseInt(stats.avg_duration_seconds) || 0,
                max_duration_seconds: parseInt(stats.max_duration_seconds) || 0,
                first_activity: stats.first_activity || room.first_seen,
                last_activity: stats.last_activity || room.last_activity,
                currently_active_users: parseInt(stats.currently_active_users) || 0,
                is_currently_active: room.is_active && parseInt(stats.currently_active_users) > 0
            }
        });

    } catch (error) {
        console.error('Get room error:', error);
        res.status(500).json({ error: 'Failed to get room', details: error.message });
    }
});

// ============================================
// 7. GET ROOM PARTICIPANTS (ENHANCED)
// ============================================
router.get('/rooms/:roomId/participants', async (req, res) => {
    try {
        const { roomId } = req.params;
        const { current_only = 'true' } = req.query;

        let query;
        if (current_only === 'true') {
            query = `
                SELECT
                    u.user_id,
                    u.username,
                    u.user_avatar,
                    u.followers_count,
                    u.verification_status,
                    u.supporter_level,
                    s.joined_at,
                    s.user_position,
                    s.mic_was_on
                FROM sessions s
                JOIN users u ON s.user_id = u.user_id
                WHERE s.room_id = $1 AND s.is_currently_active = true
                ORDER BY s.user_position ASC NULLS LAST, s.joined_at ASC
            `;
        } else {
            query = `
                SELECT DISTINCT ON (u.user_id)
                    u.user_id,
                    u.username,
                    u.user_avatar,
                    u.followers_count,
                    u.verification_status,
                    u.supporter_level,
                    MAX(s.joined_at) as last_joined,
                    COUNT(s.session_id) as total_sessions
                FROM sessions s
                JOIN users u ON s.user_id = u.user_id
                WHERE s.room_id = $1
                GROUP BY u.user_id, u.username, u.user_avatar, u.followers_count, u.verification_status, u.supporter_level
                ORDER BY u.user_id, last_joined DESC
            `;
        }

        const result = await pool.query(query, [roomId]);
        res.json(result.rows);

    } catch (error) {
        console.error('Get participants error:', error);
        res.status(500).json({ error: 'Failed to get participants', details: error.message });
    }
});

// ============================================
// 8. GET ROOM TIMELINE (ENHANCED)
// ============================================
router.get('/rooms/:roomId/timeline', async (req, res) => {
    try {
        const { roomId } = req.params;
        const { limit = 100, offset = 0, event_type } = req.query;

        let whereClause = 's.room_id = $1';
        const params = [roomId];

        if (event_type && (event_type === 'join' || event_type === 'leave')) {
            params.push(event_type);
            whereClause += ` AND s.event_type = $${params.length}`;
        }

        const query = `
            SELECT
                s.session_id,
                s.user_id,
                u.username,
                u.user_avatar,
                u.verification_status,
                s.joined_at,
                s.left_at,
                s.duration_seconds,
                s.event_type,
                s.is_currently_active
            FROM sessions s
            JOIN users u ON s.user_id = u.user_id
            WHERE ${whereClause}
            ORDER BY s.joined_at DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;

        params.push(limit, offset);
        const result = await pool.query(query, params);

        res.json(result.rows);

    } catch (error) {
        console.error('Get timeline error:', error);
        res.status(500).json({ error: 'Failed to get timeline', details: error.message });
    }
});

// ============================================
// 9. GET ROOM SNAPSHOTS (NEW)
// ============================================
router.get('/rooms/:roomId/snapshots', async (req, res) => {
    try {
        const { roomId } = req.params;
        const { limit = 50, offset = 0, start_date, end_date } = req.query;

        let whereClause = 'room_id = $1';
        const params = [roomId];

        if (start_date) {
            params.push(start_date);
            whereClause += ` AND snapshot_time >= $${params.length}`;
        }

        if (end_date) {
            params.push(end_date);
            whereClause += ` AND snapshot_time <= $${params.length}`;
        }

        const query = `
            SELECT 
                snapshot_id,
                room_id,
                snapshot_time,
                participants_count,
                participants_json,
                is_active
            FROM room_snapshots
            WHERE ${whereClause}
            ORDER BY snapshot_time DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;

        params.push(limit, offset);
        const result = await pool.query(query, params);

        // Parse JSON for easier consumption
        const formattedResults = result.rows.map(row => ({
            ...row,
            participants: typeof row.participants_json === 'string' 
                ? JSON.parse(row.participants_json) 
                : row.participants_json,
            participants_json: undefined // Remove redundant field
        }));

        // Get total count
        const countQuery = `
            SELECT COUNT(*) as total
            FROM room_snapshots
            WHERE ${whereClause}
        `;
        const countResult = await pool.query(countQuery, params.slice(0, params.length - 2));

        res.json({
            snapshots: formattedResults,
            pagination: {
                total: parseInt(countResult.rows[0].total),
                limit: parseInt(limit),
                offset: parseInt(offset),
                has_more: parseInt(offset) + formattedResults.length < parseInt(countResult.rows[0].total)
            }
        });

    } catch (error) {
        console.error('Get snapshots error:', error);
        res.status(500).json({ error: 'Failed to get snapshots', details: error.message });
    }
});

// ============================================
// 10. FIND SHARED ROOMS (ENHANCED)
// ============================================
router.get('/users/:user1Id/shared/:user2Id', async (req, res) => {
    try {
        const { user1Id, user2Id } = req.params;
        const { min_overlaps = 1 } = req.query;

        const query = `
            SELECT
                r.room_id,
                r.language,
                r.topic,
                r.skill_level,
                r.is_active,
                COUNT(DISTINCT s1.session_id) as user1_sessions,
                COUNT(DISTINCT s2.session_id) as user2_sessions,
                COUNT(DISTINCT CASE 
                    WHEN s1.joined_at <= COALESCE(s2.left_at, NOW()) 
                    AND s2.joined_at <= COALESCE(s1.left_at, NOW())
                    THEN s1.session_id 
                END) as overlap_count,
                MAX(LEAST(
                    COALESCE(s1.left_at, NOW()),
                    COALESCE(s2.left_at, NOW())
                )) as last_overlap_time,
                MIN(GREATEST(s1.joined_at, s2.joined_at)) as first_overlap_time
            FROM rooms r
            JOIN sessions s1 ON r.room_id = s1.room_id AND s1.user_id = $1
            JOIN sessions s2 ON r.room_id = s2.room_id AND s2.user_id = $2
            GROUP BY r.room_id, r.language, r.topic, r.skill_level, r.is_active
            HAVING COUNT(DISTINCT CASE 
                WHEN s1.joined_at <= COALESCE(s2.left_at, NOW()) 
                AND s2.joined_at <= COALESCE(s1.left_at, NOW())
                THEN s1.session_id 
            END) >= $3
            ORDER BY overlap_count DESC, last_overlap_time DESC
        `;

        const result = await pool.query(query, [user1Id, user2Id, min_overlaps]);
        res.json(result.rows);

    } catch (error) {
        console.error('Shared rooms error:', error);
        res.status(500).json({ error: 'Failed to find shared rooms', details: error.message });
    }
});

// ============================================
// 11. MOST STALKED USERS (ENHANCED)
// ============================================
router.get('/leaderboard/most-stalked', async (req, res) => {
    try {
        const { days = 7, limit = 100 } = req.query;

        const query = `
            SELECT
                u.user_id,
                u.username,
                u.user_avatar,
                u.followers_count,
                u.verification_status,
                u.supporter_level,
                COUNT(pv.view_id) as views_in_period,
                u.profile_views_count as total_views,
                MAX(pv.viewed_at) as last_viewed
            FROM users u
            LEFT JOIN profile_views pv ON u.user_id = pv.viewed_user_id
                AND pv.viewed_at >= NOW() - INTERVAL '1 day' * $1
            WHERE u.profile_views_count > 0 OR COUNT(pv.view_id) > 0
            GROUP BY u.user_id, u.username, u.user_avatar, u.followers_count, u.verification_status, u.supporter_level, u.profile_views_count
            HAVING COUNT(pv.view_id) > 0
            ORDER BY views_in_period DESC, total_views DESC
            LIMIT $2
        `;

        const result = await pool.query(query, [days, limit]);
        res.json(result.rows);

    } catch (error) {
        console.error('Leaderboard error:', error);
        res.status(500).json({ error: 'Failed to get leaderboard', details: error.message });
    }
});

// ============================================
// 12. MOST ACTIVE USERS (NEW)
// ============================================
router.get('/leaderboard/most-active', async (req, res) => {
    try {
        const { limit = 100, by = 'sessions', days } = req.query;

        let dateFilter = '';
        const params = [];

        if (days) {
            params.push(days);
            dateFilter = `WHERE s.joined_at >= NOW() - INTERVAL '1 day' * $${params.length}`;
        }

        let orderBy = 'total_sessions DESC';
        if (by === 'time') {
            orderBy = 'total_time_seconds DESC';
        } else if (by === 'rooms') {
            orderBy = 'rooms_visited DESC';
        }

        params.push(limit);

        const query = `
            SELECT 
                u.user_id,
                u.username,
                u.user_avatar,
                u.verification_status,
                u.supporter_level,
                u.followers_count,
                COUNT(DISTINCT s.session_id) as total_sessions,
                COALESCE(SUM(s.duration_seconds), 0)::BIGINT as total_time_seconds,
                COUNT(DISTINCT s.room_id) as rooms_visited,
                MAX(s.joined_at) as last_active,
                AVG(s.duration_seconds)::INTEGER as avg_session_duration
            FROM users u
            JOIN sessions s ON u.user_id = s.user_id
            ${dateFilter}
            GROUP BY u.user_id, u.username, u.user_avatar, u.verification_status, u.supporter_level, u.followers_count
            ORDER BY ${orderBy}
            LIMIT $${params.length}
        `;

        const result = await pool.query(query, params);
        res.json(result.rows);

    } catch (error) {
        console.error('Most active error:', error);
        res.status(500).json({ error: 'Failed to get most active users', details: error.message });
    }
});

// ============================================
// 13. TRENDING ROOMS (NEW)
// ============================================
router.get('/rooms/trending', async (req, res) => {
    try {
        const { hours = 24, limit = 20, language, skill_level } = req.query;

        let whereClause = `s.joined_at >= NOW() - INTERVAL '1 hour' * $1`;

        const params = [hours];

        if (language) {
            params.push(language);
            whereClause += ` AND r.language = $${params.length}`;
        }

        if (skill_level) {
            params.push(skill_level);
            whereClause += ` AND r.skill_level = $${params.length}`;
        }

        params.push(limit);

        const query = `
            SELECT
                r.room_id,
                r.topic,
                r.language,
                r.second_language,
                r.skill_level,
                r.is_active,
                r.current_users_count,
                r.max_capacity,
                r.is_locked,
                r.creator_name,
                r.creator_avatar,
                r.creator_is_verified,
                COUNT(DISTINCT s.user_id) as unique_visitors,
                COUNT(s.session_id) as total_sessions,
                MAX(s.joined_at) as last_activity
            FROM rooms r
            JOIN sessions s ON r.room_id = s.room_id
            WHERE ${whereClause}
            GROUP BY r.room_id, r.topic, r.language, r.second_language, r.skill_level, 
                     r.is_active, r.current_users_count, r.max_capacity, r.is_locked,
                     r.creator_name, r.creator_avatar, r.creator_is_verified
            ORDER BY unique_visitors DESC, total_sessions DESC
            LIMIT $${params.length}
        `;

        const result = await pool.query(query, params);
        res.json(result.rows);

    } catch (error) {
        console.error('Trending rooms error:', error);
        res.status(500).json({ error: 'Failed to get trending rooms', details: error.message });
    }
});

// ============================================
// 14. ACTIVE ROOMS (NEW)
// ============================================
router.get('/rooms/active', async (req, res) => {
    try {
        const { language, skill_level, limit = 50, sort = 'users' } = req.query;

        let whereClause = 'is_active = true';
        const params = [];

        if (language) {
            params.push(language);
            whereClause += ` AND language = $${params.length}`;
        }

        if (skill_level) {
            params.push(skill_level);
            whereClause += ` AND skill_level = $${params.length}`;
        }

        let orderBy = 'current_users_count DESC';
        if (sort === 'recent') {
            orderBy = 'last_activity DESC';
        } else if (sort === 'popular') {
            orderBy = 'current_users_count DESC, last_activity DESC';
        }

        params.push(limit);

        const query = `
            SELECT 
                room_id,
                topic,
                language,
                second_language,
                skill_level,
                current_users_count,
                max_capacity,
                is_full,
                is_empty,
                is_locked,
                mic_allowed,
                mic_required,
                no_mic,
                creator_name,
                creator_avatar,
                creator_is_verified,
                last_activity,
                allows_unlimited
            FROM rooms
            WHERE ${whereClause}
            ORDER BY ${orderBy}
            LIMIT $${params.length}
        `;

        const result = await pool.query(query, params);
        res.json(result.rows);

    } catch (error) {
        console.error('Active rooms error:', error);
        res.status(500).json({ error: 'Failed to get active rooms', details: error.message });
    }
});

// ============================================
// 15. SEARCH ROOMS (NEW)
// ============================================
router.get('/rooms/search', async (req, res) => {
    try {
        const { q, limit = 20, active_only = 'false' } = req.query;

        if (!q || q.length < 2) {
            return res.json([]);
        }

        let whereClause = '(LOWER(topic) LIKE LOWER($1) OR LOWER(language) LIKE LOWER($1))';
        if (active_only === 'true') {
            whereClause += ' AND is_active = true';
        }

        const query = `
            SELECT 
                room_id,
                topic,
                language,
                second_language,
                skill_level,
                is_active,
                current_users_count,
                max_capacity,
                is_locked,
                last_activity,
                creator_name
            FROM rooms
            WHERE ${whereClause}
            ORDER BY 
                is_active DESC,
                current_users_count DESC,
                last_activity DESC
            LIMIT $2
        `;

        const result = await pool.query(query, [`%${q}%`, limit]);
        res.json(result.rows);

    } catch (error) {
        console.error('Search rooms error:', error);
        res.status(500).json({ error: 'Failed to search rooms', details: error.message });
    }
});

// ============================================
// 16. GLOBAL STATISTICS (ENHANCED)
// ============================================
router.get('/stats', async (req, res) => {
    try {
        const query = `
            SELECT
                (SELECT COUNT(*) FROM users) as total_users,
                (SELECT COUNT(*) FROM rooms) as total_rooms,
                (SELECT COUNT(*) FROM rooms WHERE is_active = true) as active_rooms,
                (SELECT COUNT(*) FROM sessions WHERE is_currently_active = true) as active_sessions,
                (SELECT COUNT(*) FROM sessions) as total_sessions,
                (SELECT COUNT(*) FROM profile_views WHERE viewed_at >= NOW() - INTERVAL '24 hours') as views_24h,
                (SELECT COUNT(*) FROM room_snapshots) as total_snapshots,
                (SELECT COUNT(DISTINCT user_id) FROM sessions WHERE joined_at >= NOW() - INTERVAL '24 hours') as active_users_24h,
                (SELECT COUNT(DISTINCT user_id) FROM sessions WHERE joined_at >= NOW() - INTERVAL '7 days') as active_users_7d,
                (SELECT COALESCE(SUM(duration_seconds), 0)::BIGINT FROM sessions) as total_watch_time_seconds
        `;

        const result = await pool.query(query);
        res.json(result.rows[0]);

    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: 'Failed to get stats', details: error.message });
    }
});

// ============================================
// 17. LANGUAGE STATISTICS (NEW)
// ============================================
router.get('/stats/languages', async (req, res) => {
    try {
        const { days } = req.query;

        let dateFilter = '';
        const params = [];

        if (days) {
            params.push(days);
            dateFilter = `WHERE s.joined_at >= NOW() - INTERVAL '1 day' * $${params.length}`;
        }

        const query = `
            SELECT 
                r.language,
                COUNT(DISTINCT r.room_id) as room_count,
                COUNT(DISTINCT s.user_id) as unique_users,
                COUNT(s.session_id) as total_sessions,
                COALESCE(SUM(s.duration_seconds), 0)::BIGINT as total_time_seconds,
                AVG(s.duration_seconds)::INTEGER as avg_session_duration
            FROM rooms r
            LEFT JOIN sessions s ON r.room_id = s.room_id ${dateFilter.replace('WHERE', 'AND')}
            GROUP BY r.language
            ORDER BY unique_users DESC, total_sessions DESC
        `;

        const result = await pool.query(query, params);
        res.json(result.rows);

    } catch (error) {
        console.error('Language stats error:', error);
        res.status(500).json({ error: 'Failed to get language statistics', details: error.message });
    }
});

// ============================================
// 18. SKILL LEVEL STATISTICS (NEW)
// ============================================
router.get('/stats/skills', async (req, res) => {
    try {
        const query = `
            SELECT 
                skill_level,
                COUNT(DISTINCT room_id) as room_count,
                COUNT(DISTINCT s.user_id) as unique_users,
                COUNT(s.session_id) as total_sessions,
                AVG(s.duration_seconds)::INTEGER as avg_session_duration
            FROM rooms r
            LEFT JOIN sessions s ON r.room_id = s.room_id
            GROUP BY skill_level
            ORDER BY total_sessions DESC
        `;

        const result = await pool.query(query);
        res.json(result.rows);

    } catch (error) {
        console.error('Skill stats error:', error);
        res.status(500).json({ error: 'Failed to get skill level statistics', details: error.message });
    }
});

// ============================================
// 19. RECORD PROFILE VIEW (NEW POST ENDPOINT)
// ============================================
router.post('/users/:userId/view', async (req, res) => {
    try {
        const { userId } = req.params;

        // Check if user exists
        const userCheck = await pool.query('SELECT user_id FROM users WHERE user_id = $1', [userId]);
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        await recordProfileView(userId, req);

        res.json({ success: true, message: 'Profile view recorded' });

    } catch (error) {
        console.error('Record view error:', error);
        res.status(500).json({ error: 'Failed to record view', details: error.message });
    }
});

// ============================================
// 20. GET ROOM ANALYTICS (NEW)
// ============================================
router.get('/rooms/:roomId/analytics', async (req, res) => {
    try {
        const { roomId } = req.params;
        const { days = 30 } = req.query;

        const query = `
            SELECT 
                date,
                total_participants,
                unique_participants,
                total_sessions,
                avg_session_duration_seconds,
                peak_concurrent_users
            FROM room_analytics
            WHERE room_id = $1
                AND date >= CURRENT_DATE - $2::INTEGER
            ORDER BY date DESC
        `;

        const result = await pool.query(query, [roomId, days]);
        res.json(result.rows);

    } catch (error) {
        console.error('Room analytics error:', error);
        res.status(500).json({ error: 'Failed to get room analytics', details: error.message });
    }
});

// ============================================
// 21. HEALTH CHECK
// ============================================
router.get('/health', async (req, res) => {
    try {
        // Test database connection
        await pool.query('SELECT 1');
        res.json({ 
            status: 'healthy', 
            database: 'connected',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(503).json({ 
            status: 'unhealthy', 
            database: 'disconnected',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

module.exports = router;