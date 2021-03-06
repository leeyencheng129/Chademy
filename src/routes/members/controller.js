const db = require(__dirname + '/../../db_connect2')

const moment = require('moment-timezone')

// 生成 JSON WEB TOKEN
const jwt = require('jsonwebtoken')

// 加密 解密
const { encry, decrypt } = require(__dirname + '/../../utils/crypto')
const emailService = require(__dirname + '/../../utils/mail')() //
const { creditCardFormat } = require(__dirname + '/../../utils')

console.log(emailService, emailService.send)

// SQL
const Login = require(__dirname + '/modules/login')
const Register = require(__dirname + '/modules/register')

// const EXPIRES_IN = 15 * 1000 // NOTE: 測試用 10 秒
const EXPIRES_IN = 1 * 60 * 60 * 1000 // 過期時間一小時

// 登入驗證 token
function getAuthToken(data) {
  return jwt.sign(data, process.env.TOKEN_SECRET)
}

// 導出模組
module.exports = {
  // 登入
  async login(req, res, next) {
    let Member = new Login(req.body.email) // 之後需要加密 encry
    const [response] = await db.query(Member.getSQL())

    // Setp 1: 檢查 email 是否存在
    if (!response.length) {
      return res.json({
        success: false,
        msg: '請輸入正確的帳號或密碼',
        data: null,
      })
    }

    // Setp 2: 比對解密後的密碼是否相同
    const passwordEqual =
      decrypt(response[0].password) === decrypt(encry(req.body.password))

    if (!passwordEqual) {
      return res.json({
        success: false,
        msg: '請輸入正確的帳號或密碼',
        data: null,
      })
    }

    // otherData: 除了 password 的其他資料，前端登入後不需要知道密碼
    const { password, ...otherData } = response[0]

    // 存使用者的 token 在 jwt
    const authToken = getAuthToken(otherData.token)

    // 將其他資料在 data 中展開
    const data = { ...otherData, authToken: authToken }

    console.log(
      ' =>  比對密碼: ',
      passwordEqual,
      decrypt(response[0].password),
      decrypt(encry(req.body.password))
    )

    res.json({
      success: true,
      msg: '歡迎' + response[0].name + '的登入!',
      data: data,
    })
  },

  // 註冊
  async register(req, res, next) {
    // 取出 email, mobile，驗證是否註冊過
    const { email, mobile } = req.body

    let Member = new Register({ email, mobile })

    const checkEmailMobile = async () => {
      const [emailRes] = await db.query(Member.queryEmail())
      const [mobileRes] = await db.query(Member.queryMobile())

      const noEmail = emailRes.length === 0 // 沒有信箱資料
      const noMobile = mobileRes.length === 0 // 沒有手機資料
      const noRegister = noEmail && noMobile // 兩者皆無，就是沒註冊

      return { noRegister, noEmail, noMobile }
    }

    //  新增
    const insertUser = async () => {
      // 拷貝前端的請求參數，建立時間，加密 password
      const data = {
        ...req.body,
        created_at: new Date(),
        password: encry(req.body.password),
      }

      console.log(
        'token:',

        encry(JSON.stringify(req.body)),
        '加密後: ',
        encry(req.body.password),
        '\n 解密後: ',
        decrypt(encry(req.body.password))
      )

      console.log(789, data)

      const result = await db.query('INSERT INTO `members` set ?', [data])

      // 把存入 db 的資料拿來生成認證信箱的 token
      const token = encry(JSON.stringify(data))

      // 然後透過 sid 將 [認證信 token] 更新到資料庫
      const [{ insertId }] = result
      const UPDATE_TOKEN_SQL = 'UPDATE `members` SET token = ? WHERE sid = ?'
      await db.query(UPDATE_TOKEN_SQL, [token, insertId])

      // 返回以下資料
      return { result, token }
    }

    // 取得註冊狀態
    const { noRegister, noEmail, noMobile } = await checkEmailMobile()

    console.log(
      '取得註冊狀態\n',
      '是否註冊過: ',
      noRegister,
      ', 郵件是否使用過: ',
      noEmail,
      ', 手機是否使用過: ',
      noMobile
    )

    // 沒有註冊過
    if (noRegister) {
      // 新增註冊的會員
      const { result, token } = await insertUser()

      console.log(' 新增註冊的會員 => ', result)

      // 有註冊才寄信
      if (result.length > 0) {
        console.log('註冊結果: ', result.length > 0, email)

        res.json({
          success: true,
          msg: '註冊成功！請去信箱查看會員認證信件。',
          data: null,
        })

        console.log(' 寄出認證信 ')

        // https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/encodeURIComponent
        // 因為透過 GET 要 encodeURIComponent 加密過的 TOKEN，接 token 才能拿到正確的值
        const apiUrl = `http://${req.headers.host}/members/userAuth?token=`

        // 先將會員資料用 JSON.stringify 轉成字串，然後 encry 加密，最後 encodeURIComponent
        const encodeToken = `${encodeURIComponent(token)}`
        const data = apiUrl + encodeToken

        emailService.send({ to: email, data: data })
      }
    } else {
      res.json({
        success: false,
        msg: '抱歉，註冊失敗！',
        data: {
          noEmail: noEmail ? null : '信箱已經使用過！',
          noMobile: noMobile ? null : '手機已經使用過！',
        },
      })
    }
  },

  // 帳號驗證
  async userAuth(req, res, next) {
    const { token } = req.query

    // 拿 token 去找有沒有會員
    let QUERY_SQL = `SELECT * FROM members WHERE token = ?`
    const [[userData]] = await db.query(QUERY_SQL, [token])

    // 找不到會員
    if (!userData) {
      res.send(`
        <h1 style="
          text-align: center;
          margin-top: 30vh;
        ">查無會員</h1>
      `)

      return
    }

    // 透過 sid 將會員的 status 設定成 1，代表啟用。
    const STATUS_SQL = 'UPDATE `members` SET status = 1 WHERE sid = ?'
    const [{ changedRows, affectedRows }] = await db.query(STATUS_SQL, [
      userData.sid,
    ])

    // changedRows: 1 代表更新成功, 0 沒有更新
    // affectedRows: 1 代表有這筆資料, 0 沒有這筆資料

    if (changedRows === 1) {
      res.send(`
        <div style="
          box-sizing: border-box;
          position: relative;
          max-width: 480px;
          margin: 0 auto;
          padding: 134px 0 96px;
          text-align: center;
        ">
          <h1>會員認證成功</h1>
        </div>
      `)
    }

    if (changedRows === 0 && affectedRows === 1) {
      res.send(`
      <div style="
        box-sizing: border-box;
        position: relative;
        max-width: 480px;
        margin: 0 auto;
        padding: 134px 0 96px;
        text-align: center;
      ">
        <h1>會員已認證成功</h1>
      </div>
    `)
    }
  },

  // 測試
  async loginTest(req, res, next) {
    console.log(' => loginTest ')

    res.json({ success: '測試成功' })
  },

  async getTest(req, res, next) {
    const { test } = req.query
    console.log(123, 'decodeURI(test)', decodeURI(test))
    console.log(JSON.stringify(req.cookie), JSON.stringify(req.cookies))

    res.json({})
  },

  // 忘記密碼
  async forgetPwd(req, res) {
    let email = req.body.email

    // 拿 token 去找有沒有會員
    let QUERY_SQL = `SELECT token FROM members WHERE email = ?`
    const [row] = await db.query(QUERY_SQL, [email])

    if (!row.length) {
      return res.json({
        success: false,
        msg: '寄送失敗，這個信箱還未註冊過',
        data: null,
      })
    }

    const options = {
      to: email,
      subject: 'Chademy 會員身分重設密碼',
      html: `
        <h1>親愛的Chademy會員您好:</h1><br>
        <h3>請點擊下方進行重新設定密碼</h3><br>
        <a href="http://localhost:3000/reset-password?token=${row[0].token}">
          <h2>重設密碼頁</h2>
        </a>`,
    }

    emailService.send(options).then(() => {
      // 寄信成功後
      res.json({
        success: true,
        msg: '請到信箱修改密碼',
        data: null,
      })
    })
  },

  //修改會員密碼
  async changePassword(req, res, next) {
    let email = req.body.email
    let password = req.body.password
    // console.log(number, password);
    let sql = `UPDATE members SET password = '${password}' WHERE email = '${email}' `

    db.query(sql, (err, row) => {
      if (err) return res.json({ err: err })
      // console.log(row);
      if (row.changedRows == 0) {
        res.json({
          success: false,
          msg: '信箱有誤',
          data: null,
        })
        return
      } else {
        res.json({
          success: true,
          msg: '完成密碼更新',
          data: null,
        })
      }
    })
  },

  // 更新密碼
  async resetPWD(req, res, next) {
    const token = req.body.token
    const password = req.body.password

    // 確認 token
    const QUERY_SQL = `SELECT email FROM members WHERE token = ?`
    const [emailRow] = await db.query(QUERY_SQL, [token])

    console.log(emailRow, emailRow[0])

    if (!emailRow.length) {
      res.json({
        success: false,
        msg: '密碼更新失敗',
        data: emailRow[0],
      })
      return
    }

    // 確認 token

    const UPDATE_PWD_SQL = 'UPDATE `members` SET password = ? WHERE token = ?'
    const [row] = await db.query(UPDATE_PWD_SQL, [encry(password), token])

    console.log(row)

    res.json({
      success: true,
      msg: '密碼更新成功',
      data: row[0],
    })
  },

  // example
  async example(req, res, next) {
    const { sid } = req.body

    console.log('  sid', sid)

    const QUERY_SQL = `SELECT * FROM members WHERE sid = ?`
    const [row] = await db.query(QUERY_SQL, [sid])

    console.log(row)

    res.json('\n => example OK! \n')
  },

  // 個人資料撈出來
  async getUserInfo(req, res, next) {
    // const { token } = req.body //跟前端拿請求，怎麼拿，post百分之兩百從body拿

    // 改成 res.session.sid 拿
    if (!req.session.sid) return res.status(401).send('請重新登入')

    const QUERY_SQL = `SELECT name, mobile, birthday, avatar FROM members WHERE sid = ?` // 從後端資料庫拿你指定要的資料
    const [row] = await db.query(QUERY_SQL, [req.session.sid]) //從資料庫拿出來 row(那筆資料)

    row[0].birthday = moment(row[0].birthday).format('YYYY-MM-DD')

    res.json({
      success: true,
      msg: '會員資料已傳送',
      data: row[0],
    })
  },

  // 編輯會員資料 - 儲存
  async setUserInfo(req, res, next) {
    // 改成 res.session.sid 拿
    if (!req.session.sid) return res.status(401).send('請重新登入')

    const { name, mobile, birthday, avatar } = req.body

    if (!name || !mobile || !birthday || !avatar) {
      return res.json({
        success: false,
        msg: '會員資料格式錯誤',
        data: null,
      })
    }

    const UPDATE_SQL = `
      UPDATE members
      SET name = ?, mobile = ?, birthday = ?, avatar = ?
      WHERE sid = ?`

    const [{ changedRows }] = await db.query(UPDATE_SQL, [
      name,
      mobile,
      birthday,
      avatar,
      req.session.sid,
    ])

    res.json({
      success: !!changedRows,
      msg: `編輯會員資料${changedRows ? '成功' : '失敗'}`,
      data: { name, mobile, birthday, avatar },
    })
  },

  //coupon資料撈出來
  async getUserCouponInfo(req, res, next) {
    const { token } = req.body //跟前端拿請求，怎麼拿，post百分之兩百從body拿

    const QUERY_SQL = `SELECT sid FROM members WHERE token = ?` // 從表裡透過where拿到select
    const [[{ sid } = {}]] = await db.query(QUERY_SQL, [token]) //從資料庫拿出來 row(那筆資料)

    console.log(sid) //row  => []  or [{ sid }]

    if (sid) {
      const QUERY_SQL1 = `SELECT * FROM coupon_receive CR  LEFT JOIN coupon C ON CR.coupon_id = C.coupon_id  WHERE user_id = ?` // 從後端資料庫拿你指定要的資料
      const [couponrow] = await db.query(QUERY_SQL1, [sid])

      console.log('couponrow', '\n', couponrow)
      res.json({
        success: true,
        msg: '會員折價券資料已傳送',
        data: couponrow,
      })
    } else {
      res.json({
        success: false,
        msg: '會員折價券資料傳送失敗啦幹',
        data: null,
      })
    }
  },

  // 編輯 creditcard
  async setUserCreditcardInfo(req, res, next) {
    const { token, data } = req.body //跟前端拿請求，怎麼拿，post百分之兩百從body拿
    const { cardNumber, cardHolder, cardMonth, cardYear, cardCvv } = data

    // 沒有來源資料(data.originCard)，就代表新增
    if (!data.originCard) {
      const QUERY_SQL = `SELECT sid FROM members WHERE token = ?` // 從表裡透過where拿到select
      const [[{ sid } = {}]] = await db.query(QUERY_SQL, [token]) //從資料庫拿出來 row(那筆資料)

      const INSERT_SQL = `
        INSERT INTO credit_card
        SET
          user_id = ?,
          name = ?,
          card_number = ?,
          expiry_date = ?,
          security_code = ?,
          create_time = ?`

      const [{ affectedRows, insertId }] = await db.query(INSERT_SQL, [
        sid, // user_id
        cardHolder,
        cardNumber.replace(/\s/g, ''), // 移除空格
        `${cardMonth}/${cardYear.slice(-2)}`,
        cardCvv,
        moment(new Date()).format('YYYY-MM-DD'),
      ])

      let creditCardRow = null
      if (affectedRows) {
        // 如果更新成功了，就撈更新過的資料，並回傳給前端
        const [
          row,
        ] = await db.query(`SELECT * FROM credit_card WHERE user_id = ?`, [sid])

        creditCardRow = row
      }

      return res.json({
        success: !!affectedRows,
        msg: `會員信用卡資料新增${!!affectedRows ? '成功' : '失敗'}`,
        data: creditCardRow ? creditCardFormat(creditCardRow) : creditCardRow,
      })
    }

    // 以下為更新
    const { sid, user_id } = data.originCard

    const UPDATE_SQL = `
      UPDATE credit_card
      SET
        card_number = ?,
        name = ?,
        expiry_date = ?,
        security_code = ?
      WHERE sid =? AND user_id = ?`

    // 更新
    const [{ changedRows }] = await db.query(UPDATE_SQL, [
      cardNumber.replace(/\s/g, ''), // 移除空格
      cardHolder,
      `${cardMonth}/${cardYear.slice(-2)}`,
      cardCvv,
      sid, // 信用卡的 sid
      user_id,
    ])

    let creditCardRow = null
    if (changedRows) {
      // 如果更新成功了，就撈更新過的資料，並回傳給前端
      const [
        row,
      ] = await db.query(`SELECT * FROM credit_card WHERE user_id = ?`, [
        user_id,
      ])

      creditCardRow = row
    }

    return res.json({
      success: !!changedRows,
      msg: `會員信用卡資料更新${!!changedRows ? '成功' : '失敗'}`,
      data: creditCardRow ? creditCardFormat(creditCardRow) : creditCardRow,
    })
  },

  //creditcard資料撈出來
  async getUserCreditcardInfo(req, res, next) {
    const { token } = req.body //跟前端拿請求，怎麼拿，post百分之兩百從body拿
    console.log()

    const QUERY_SQL = `SELECT sid FROM members WHERE token = ?` // 從表裡透過where拿到select
    const [[{ sid } = {}]] = await db.query(QUERY_SQL, [token]) //從資料庫拿出來 row(那筆資料)

    console.log(sid) //row  => []  or [{ sid }]

    if (sid) {
      const QUERY_SQL1 = `SELECT * FROM credit_card WHERE user_id = ?` // 從後端資料庫拿你指定要的資料
      const [creditCardRow] = await db.query(QUERY_SQL1, [sid])

      res.json({
        success: true,
        msg: '會員信用卡資料已傳送',
        data: creditCardFormat(creditCardRow),
      })
    } else {
      res.json({
        success: false,
        msg: '會員visa資料傳送失敗啦',
        data: null,
      })
    }
  },

  // 電子郵件撈出來
  async getUserEmail(req, res, next) {
    const { token } = req.body //跟前端拿請求，怎麼拿，post百分之兩百從body拿
    console.log()

    const QUERY_SQL = `SELECT email FROM members WHERE token = ?` // 從後端資料庫拿你指定要的資料
    const [row] = await db.query(QUERY_SQL, [token]) //從資料庫拿出來 row(那筆資料)

    // row[0].birthday = moment(row[0].birthday).format('YYYY-MM-DD')

    console.log(' row[0]: ', row[0])

    res.json({
      success: true,
      msg: '電子郵件已傳送',
      data: row[0],
    })
  },

  // 編輯信箱資料 - 儲存
  async setUserEmail(req, res, next) {
    const { email } = req.body // 跟前端拿請求，怎麼拿，post百分之兩百從body拿

    // 改成 res.session.sid 拿
    if (!req.session.sid) return res.status(401).send('請重新登入')

    if (!email) {
      return res.json({
        success: false,
        msg: '會員資料格式錯誤',
        data: null,
      })
    }

    const UPDATE_TOKEN_SQL = `UPDATE members SET email = ? WHERE sid = ?`
    const [{ changedRows }] = await db.query(UPDATE_TOKEN_SQL, [
      email,
      req.session.sid,
    ])

    console.log({
      success: !!changedRows,
      msg: `編輯信箱資料${changedRows ? '成功' : '失敗'}`,
      data: null,
    })

    res.json({
      success: !!changedRows,
      msg: `編輯信箱資料${changedRows ? '成功' : '失敗'}`,
      data: null,
    })
  },

  // 編輯密碼資料 - 儲存
  async setUserPass(req, res, next) {
    // 改成 res.session.sid 拿
    if (!req.session.sid) return res.status(401).send('請重新登入')

    const { oldPassword, newPassword } = req.body // 跟前端拿請求，怎麼拿，post百分之兩百從body拿

    const QUERY_SQL = `SELECT password FROM members WHERE sid = ?`
    const [row] = await db.query(QUERY_SQL, [req.session.sid]) //從資料庫拿出來 row(那筆資料)

    // Setp 2: 比對解密後的密碼是否相同
    const passwordEqual =
      decrypt(row[0].password) === decrypt(encry(oldPassword))

    if (!passwordEqual) {
      return res.json({
        success: false,
        msg: '會員舊密碼錯誤',
        data: null,
      })
    }

    const UPDATE_PWD_SQL = `UPDATE members SET password = ? WHERE sid = ?`
    const [{ changedRows }] = await db.query(UPDATE_PWD_SQL, [
      encry(newPassword),
      req.session.sid,
    ])

    console.log({
      success: !!changedRows,
      msg: `編輯密碼資料${changedRows ? '成功' : '失敗'}`,
      data: null,
    })

    res.json({
      success: !!changedRows,
      msg: `編輯密碼資料${changedRows ? '成功' : '失敗'}`,
      data: null,
    })
  },

  // 評論撈出來，GET/POST 共用
  async getCommentt(req, res, next) {
    if (!req.session.sid) return res.status(401).send('請重新登入')

    const { sid } = req.params // 評論的 sid
    console.log('  req.query  => ', req.query, req.params)

    // 1. GET: 若有  req.params.sid 代表 GET 請求
    if (sid) {
      const ONE_COMMENT = `
        SELECT R.sid, name, order_no, review_title, avatar, buy_product, stars, review_comment, review_time, photo
        FROM w_review R
        LEFT JOIN members M
        ON R.user_id = M.sid
        WHERE R.sid = ?`
      const [row] = await db.query(ONE_COMMENT, [sid]) //從資料庫拿出來 row(那筆資料)

      const hasData = row.length > 0

      // 將 sid 解構賦值然後改名為 review_sid， const review_sid = row[0].sid
      const { sid: review_sid, ...otherColumn } = row[0]

      const data = {
        ...otherColumn,
        review_sid,
      }

      // 返回
      return res.json({
        success: hasData,
        msg: hasData ? '自己評論的資料傳送成功' : '自己評論的資料傳送失敗啦',
        data: data,
      })
    }

    // 2. POST 請求
    const QUERY_SQL1 = `
      SELECT R.sid, avatar, buy_product, stars, review_comment, review_time, photo
      FROM w_review R
      LEFT JOIN members M
      ON R.user_id = M.sid
      WHERE user_id = ?` // 從後端資料庫拿你指定要的資料
    const [row] = await db.query(QUERY_SQL1, [req.session.sid]) //從資料庫拿出來 row(那筆資料)

    const result = row.map((column) => {
      const { sid, ...otherColumn } = column
      return {
        ...otherColumn,
        review_sid: sid,
      }
    })

    if (result.length > 0) {
      res.json({
        success: true,
        msg: '自己評論的資料傳送成功',
        data: result,
      })
    } else {
      res.json({
        success: false,
        msg: '自己評論的資料傳送失敗啦',
        data: null,
      })
    }
  },

  // 編輯評論
  async updateCommentt(req, res, next) {
    if (!req.session.sid) return res.status(401).send('請重新登入')

    const { stars, review_comment, photo, review_title, review_sid } = req.body
    const updateData = [stars, review_comment, photo, review_title, review_sid]

    const UPDATE_SQL = `
      UPDATE w_review SET stars = ?, review_comment = ?, photo = ?, review_title = ? WHERE sid = ?`

    const [{ changedRows }] = await db.query(UPDATE_SQL, updateData) //從資料庫拿出來 row(那筆資料)

    res.json({
      success: !!changedRows,
      msg: `編輯評論${changedRows ? '成功' : '失敗'}`,
      data: null,
    })
  },

  // 刪除評論
  async deleteCommentt(req, res, next) {
    if (!req.session.sid) return res.status(401).send('請重新登入')

    console.log(req.body.review_sid, req.session.sid)

    const DELETE_SQL = `DELETE FROM w_review WHERE sid = ? AND user_id = ?`
    const parasm = [req.body.review_sid, req.session.sid] // 評論 sid, 使用者 sid
    const [{ affectedRows }] = await db.query(DELETE_SQL, parasm)

    res.json({
      success: !!affectedRows,
      msg: !!affectedRows ? '刪除評論成功' : '刪除評論失敗',
      data: null,
    })
  },

  // 我的評價 撈出來
  async getEvaluation(req, res, next) {
    if (!req.session.sid) return res.status(401).send('請重新登入')

    const QUERY_SQL = `
      SELECT name, buyer_sid, stars, buyer_comment, review_time, avatar
      FROM i_comment_c2c I
      LEFT JOIN members M
      ON I.buyer_sid = M.sid
      WHERE seller_sid = ?` // 從後端資料庫拿你指定要的資料

    const [row] = await db.query(QUERY_SQL, [req.session.sid]) //從資料庫拿出來 row(那筆資料)

    if (row.length > 0) {
      res.json({
        success: true,
        msg: '自己評論的資料傳送成功',
        data: row,
      })
    } else {
      res.json({
        success: false,
        msg: '自己評論的資料傳送失敗啦',
        data: null,
      })
    }
  },

  //MYFAV資料撈出來
  async getUserMyFav(req, res, next) {
    // 改成 res.session.sid 拿
    if (!req.session.sid) return res.status(401).send('請重新登入')

    const columns = `product_name, product_no, price, photo`
    // 用 UNION ALL 語法，把兩張表集合起來，欄位需一致，且 product_no 相等
    // 然後再用 LEFT JOIN 起來，最後再把 member_id = sid 的找出來
    const SQL = `
      SELECT * FROM w_follow LEFT JOIN (
        SELECT ${columns} FROM w_product_mainlist
        UNION ALL
        SELECT ${columns} FROM i_secondhand_product
      )UALL ON w_follow.product_no = UALL.product_no WHERE member_id = ?`

    const [result] = await db.query(SQL, [req.session.sid]) //從資料庫拿出來 row(那筆資料)

    if (result.length > 0) {
      res.json({
        success: true,
        msg: '追蹤清單資料已傳送',
        data: result,
      })
    } else {
      res.json({
        success: false,
        msg: '追蹤清單資料傳送失敗啦',
        data: null,
      })
    }
  },

  // 追蹤清單刪除
  async deleteMyfav(req, res, next) {
    if (!req.session.sid) return res.status(401).send('請重新登入')

    const QUERY_SQL = `
      DELETE FROM w_follow
      WHERE sid = ?
      AND product_no = ?
      AND member_id = ? `

    const [{ affectedRows }] = await db.query(QUERY_SQL, [
      req.body.sid,
      req.body.product_no,
      req.session.sid,
    ])

    res.json({
      success: !!affectedRows,
      msg: !!affectedRows ? '移除成功' : '移除失敗',
      data: null,
    })
  },

  // 信用卡刪除
  async deleteCreditcard(req, res, next) {
    // 改成 res.session.sid 拿
    if (!req.session.sid) return res.status(401).send('請重新登入')

    const QUERY_SQL = `DELETE FROM credit_card WHERE sid = ? AND user_id = ? `
    const [{ affectedRows }] = await db.query(QUERY_SQL, [
      req.body.card_sid,
      req.session.sid,
    ])

    console.log(
      ' affectedRows: ',
      affectedRows,
      req.body.card_sid,
      req.session.sid
    )

    res.json({
      success: !!affectedRows,
      msg: !!affectedRows ? '已刪除' : '刪除失敗',
      data: null,
    })
  },

  // 撈地址
  async getAddress(req, res, next) {
    // 改成 res.session.sid 拿
    if (!req.session.sid) return res.status(401).send('請重新登入')

    const QUERY_SQL = `SELECT address FROM members WHERE sid = ?`
    const [row] = await db.query(QUERY_SQL, [req.session.sid])

    console.log(' row[0]: ', row[0])

    res.json({
      success: true,
      msg: '地址已傳送',
      data: row[0],
    })
  },
  // 編輯地址
  async setAddress(req, res, next) {
    // 改成 res.session.sid 拿
    if (!req.session.sid) return res.status(401).send('請重新登入')

    const UPDATE_ADDRESS = 'UPDATE members SET address = ? WHERE sid = ?'
    const [{ changedRows }] = await db.query(UPDATE_ADDRESS, [
      req.body.address,
      req.session.sid,
    ])

    console.log(' changedRows ', changedRows)

    let data
    if (changedRows) {
      const QUERY_SQL = `SELECT address FROM members WHERE sid = ?`
      const [[address]] = await db.query(QUERY_SQL, [req.session.sid])
      data = address
    }

    res.json({
      success: !!changedRows,
      msg: `編輯會員地址${changedRows ? '成功' : '失敗'}`,
      data: data,
    })
  },

  // 地址刪除(因為地址依附在會員表之中，所以是 UPDATE)
  async deleteAddress(req, res, next) {
    // 改成 res.session.sid 拿
    if (!req.session.sid) return res.status(401).send('請重新登入')

    const UPDATE_ADDRESS = 'UPDATE members SET address = ? WHERE sid = ?'
    const [{ changedRows }] = await db.query(UPDATE_ADDRESS, [
      '',
      req.session.sid,
    ])

    res.json({
      success: !!changedRows,
      msg: `會員地址刪除${!!changedRows ? '成功' : '失敗'}`,
      data: null,
    })
  },
}

//用token查詢email，再去修改密碼

/**
 *
 * cURL 可以直接打 api

pass
    curl -X POST -H "Content-Type: application/json" -d \
    '{ "email" : "register@pass.com", "mobile" : "PASS" }' \
    "http://localhost:3001/members/register"

email
    curl -X POST -H "Content-Type: application/json" -d \
    '{ "email" : "fsjn7w92@srqbrmhi.com", "mobile" : "Jack" }' \
    "http://localhost:3001/members/register"

mobile
    curl -X POST -H "Content-Type: application/json" -d \
    '{ "email" : "123", "mobile" : "0993306275" }' \
    "http://localhost:3001/members/register"


        curl -X POST -H "Content-Type: application/json" -d \
    '{}' \
    "http://localhost:3001/members/loginTest"


     curl -X POST -H "Content-Type: application/json" -d \
    '{"name":"test","mobile":"0928555655","birthday":"2020-11-04","address":"test","email":"enter3017sky@gmail.com","password":"999"}' \
    "http://localhost:3001/members/register"



     curl -X POST -H "Content-Type: application/json" -d \
    '{ "email":"enter3017sky@gmail.com" }' \
    "http://localhost:3001/members/forgetPwd"

     curl -X POST -H "Content-Type: application/json" -d \
    '{ "email":"test@gmail.com", "token":"U2FsdGVkX182eCyGifwALZio7nkK5dWWfcnvC1YLUaVap78/qxYfLldsnVZ7w/kcMKZ8WI0hYyfH8AY4Ss0UKiHeFX06YcDqA3tfEcn70DFjikyviHbFj4dL7B8bKIXPo/8vIxboKNyFwOPoGlUXEnr+uaBRl7RT7hglvoOYmByZqU8V+zOVyYdf+OwbOM1mJDH6ZbawqgA2iPDwmxKjyu7+kUcb6WO/K57g48x+jDRxJwJR3dTOYquNciydzk+kYxhZwqV9nsPuOxosH7dXfm5r7VE+9hnxKs86cUj7bQs9o8xqonObBZKZAIAPTmFl" }' \
    "http://localhost:3001/members/setUserEmail"



     curl -X POST -H "Content-Type: application/json" -d \
    '{ "token":"U2FsdGVkX182eCyGifwALZio7nkK5dWWfcnvC1YLUaVap78/qxYfLldsnVZ7w/kcMKZ8WI0hYyfH8AY4Ss0UKiHeFX06YcDqA3tfEcn70DFjikyviHbFj4dL7B8bKIXPo/8vIxboKNyFwOPoGlUXEnr+uaBRl7RT7hglvoOYmByZqU8V+zOVyYdf+OwbOM1mJDH6ZbawqgA2iPDwmxKjyu7+kUcb6WO/K57g48x+jDRxJwJR3dTOYquNciydzk+kYxhZwqV9nsPuOxosH7dXfm5r7VE+9hnxKs86cUj7bQs9o8xqonObBZKZAIAPTmFl" }' \
    "http://localhost:3001/members/getCommentt"




curl -X POST -H "Content-Type: application/json" -d \
'{ "sid":"158" }' \
"http://localhost:3001/members/example"



*/
