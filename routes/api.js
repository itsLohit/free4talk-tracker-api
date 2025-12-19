const express = require('express');
const router = express.Router();
const pool = require('../db');

// ========================================
// 1. SEARCH USERS
// ========================================
router.get('/users/search', async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q || q.length < 2) {
      return res.json([]);
    }

    const query = `
      SELECT 
        user_id,
        username,
        user_avatar,
        followers_count,
        verification_status,
        last_seen
      FROM users
      WHERE 
        LOWER(username) LIKE LOWER($1) OR
        LOWER(user_id) LIKE LOWER($1)
      ORDER BY followers_count DESC
      LIMIT 20
    `;

    const result = await pool.query(query, [`%${q}%`]);
    res.json(result.rows);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ========================================
// 2. GET USER PROFILE (FIXED)
// ========================================
router.get('/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const query = `
      SELECT 
        user_id,
        username,
        user_avatar,
        followers_count,
        following_count,
        friends_count,
        verification_status,
        first_seen,
        last_seen,
        profile_views_count
      FROM users
      WHERE user_id = $1
    `;

    const result = await pool.query(query, [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Return the data with proper null handling
    const user = result.rows[0];
    res.json({
      ...user,
      followers_count: user.followers_count || 0,
      following_count: user.following_count || 0,
      friends_count: user.friends_count || 0,
      profile_views_count: user.profile_views_count || 0
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});


// ========================================
// 3. GET USER ROOM HISTORY
// ========================================
router.get('/users/:userId/rooms', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const query = `
      SELECT DISTINCT ON (r.room_id)
        r.room_id,
        r.language,
        r.skill_level,
        r.topic,
        r.is_active,
        r.current_users_count,
        MAX(s.joined_at) as last_visit,
        COUNT(s.session_id) as total_visits
      FROM sessions s
      JOIN rooms r ON s.room_id = r.room_id
      WHERE s.user_id = $1
      GROUP BY r.room_id, r.language, r.skill_level, r.topic, r.is_active, r.current_users_count
      ORDER BY r.room_id, last_visit DESC
      LIMIT $2 OFFSET $3
    `;

    const result = await pool.query(query, [userId, limit, offset]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get rooms error:', error);
    res.status(500).json({ error: 'Failed to get rooms' });
  }
});

// ========================================
// 4. GET USER SESSIONS IN A ROOM
// ========================================
router.get('/users/:userId/rooms/:roomId/sessions', async (req, res) => {
  try {
    const { userId, roomId } = req.params;

    const query = `
      SELECT 
        session_id,
        joined_at,
        left_at,
        session_duration,
        is_currently_active,
        event_type
      FROM sessions
      WHERE user_id = $1 AND room_id = $2
      ORDER BY joined_at DESC
      LIMIT 100
    `;

    const result = await pool.query(query, [userId, roomId]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get sessions error:', error);
    res.status(500).json({ error: 'Failed to get sessions' });
  }
});

// ========================================
// 5. GET ROOM DETAILS
// ========================================
router.get('/rooms/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;

    const query = `
      SELECT 
        room_id,
        language,
        skill_level,
        topic,
        max_capacity,
        is_active,
        is_full,
        is_empty,
        current_users_count,
        total_participants,
        view_count,
        peak_users,
        peak_time,
        first_seen,
        last_activity
      FROM rooms
      WHERE room_id = $1
    `;

    const result = await pool.query(query, [roomId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Room not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get room error:', error);
    res.status(500).json({ error: 'Failed to get room' });
  }
});

// ========================================
// 6. GET ROOM PARTICIPANTS (Current)
// ========================================
router.get('/rooms/:roomId/participants', async (req, res) => {
  try {
    const { roomId } = req.params;

    const query = `
      SELECT 
        u.user_id,
        u.username,
        u.user_avatar,
        u.followers_count,
        s.joined_at
      FROM sessions s
      JOIN users u ON s.user_id = u.user_id
      WHERE s.room_id = $1 AND s.is_currently_active = true
      ORDER BY s.joined_at ASC
    `;

    const result = await pool.query(query, [roomId]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get participants error:', error);
    res.status(500).json({ error: 'Failed to get participants' });
  }
});

// ========================================
// 7. GET ROOM TIMELINE
// ========================================
router.get('/rooms/:roomId/timeline', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { limit = 100 } = req.query;

    const query = `
      SELECT 
        s.session_id,
        s.user_id,
        u.username,
        s.joined_at,
        s.left_at,
        s.is_currently_active
      FROM sessions s
      JOIN users u ON s.user_id = u.user_id
      WHERE s.room_id = $1
      ORDER BY s.joined_at DESC
      LIMIT $2
    `;

    const result = await pool.query(query, [roomId, limit]);
    res.json(result.rows);
  } catch (error) {
    console.error('Get timeline error:', error);
    res.status(500).json({ error: 'Failed to get timeline' });
  }
});

// ========================================
// 8. FIND SHARED ROOMS (Compare 2 Users)
// ========================================
router.get('/users/:user1Id/shared/:user2Id', async (req, res) => {
  try {
    const { user1Id, user2Id } = req.params;

    const query = `
      SELECT 
        r.room_id,
        r.language,
        r.topic,
        r.skill_level,
        COUNT(DISTINCT s1.session_id) as user1_sessions,
        COUNT(DISTINCT s2.session_id) as user2_sessions,
        MAX(LEAST(
          COALESCE(s1.left_at, NOW()), 
          COALESCE(s2.left_at, NOW())
        )) as last_overlap
      FROM rooms r
      JOIN sessions s1 ON r.room_id = s1.room_id AND s1.user_id = $1
      JOIN sessions s2 ON r.room_id = s2.room_id AND s2.user_id = $2
      WHERE 
        s1.joined_at <= COALESCE(s2.left_at, NOW()) AND
        s2.joined_at <= COALESCE(s1.left_at, NOW())
      GROUP BY r.room_id, r.language, r.topic, r.skill_level
      ORDER BY last_overlap DESC
    `;

    const result = await pool.query(query, [user1Id, user2Id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Shared rooms error:', error);
    res.status(500).json({ error: 'Failed to find shared rooms' });
  }
});

// ========================================
// 9. MOST STALKED USERS (Last 7 Days)
// ========================================
router.get('/leaderboard/most-stalked', async (req, res) => {
  try {
    const query = `
      SELECT 
        u.user_id,
        u.username,
        u.user_avatar,
        u.followers_count,
        COUNT(pv.view_id) as views_last_7_days,
        u.profile_views_count as total_views
      FROM users u
      LEFT JOIN profile_views pv ON u.user_id = pv.viewed_user_id 
        AND pv.viewed_at >= NOW() - INTERVAL '7 days'
      GROUP BY u.user_id, u.username, u.user_avatar, u.followers_count, u.profile_views_count
      ORDER BY views_last_7_days DESC
      LIMIT 100
    `;

    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ error: 'Failed to get leaderboard' });
  }
});

// ========================================
// 10. GLOBAL STATISTICS
// ========================================
router.get('/stats', async (req, res) => {
  try {
    const query = `
      SELECT
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM rooms) as total_rooms,
        (SELECT COUNT(*) FROM rooms WHERE is_active = true) as active_rooms,
        (SELECT COUNT(*) FROM sessions WHERE is_currently_active = true) as active_sessions,
        (SELECT COUNT(*) FROM sessions) as total_sessions
    `;

    const result = await pool.query(query);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

module.exports = router;
